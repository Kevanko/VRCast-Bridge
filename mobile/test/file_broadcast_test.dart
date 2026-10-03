import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:vrcast_remote/file_broadcast.dart';
import 'package:vrcast_remote/media_server.dart';
import 'package:vrcast_remote/mp4.dart';
import 'package:vrcast_remote/own_server.dart';
import 'package:vrcast_remote/rtp.dart';

String? _tool(String name) {
  final result = Process.runSync('which', [name]);
  return result.exitCode == 0 ? '${result.stdout}'.trim() : null;
}

final _mediamtx = [
  '${Platform.environment['HOME']}/.local/share/VRCastBridge/tools/mediamtx',
  '${Platform.environment['HOME']}/dev/sample/data/VRCastBridge/tools/mediamtx',
].where((p) => File(p).existsSync()).firstOrNull;

final _haveTools = _tool('ffmpeg') != null && _tool('ffprobe') != null;

void main() {
  late Directory dir;
  late String clip, clipB, quiet, hevc;

  Future<String> make(String name, List<String> args) async {
    final out = '${dir.path}/$name';
    final result = await Process.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-y', out]);
    expect(result.exitCode, 0, reason: '${result.stderr}');
    return out;
  }

  setUpAll(() async {
    if (!_haveTools) return;
    dir = await Directory.systemTemp.createTemp('vrcast-fb');
    // Кадры B, ключевой раз в секунду, звук 44,1 кГц стерео: как у обычного ролика с телефона.
    clip = await make('clip.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart']);
    clipB = await make('clipB.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100',
      '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2']); // moov в конце
    quiet = await make('quiet.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p', '-an']);
    hevc = await make('hevc.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-t', '2', '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-an']);
  });
  tearDownAll(() async {
    if (_haveTools) await dir.delete(recursive: true);
  });

  group('разбор mp4', () {
    test('кадры, ключевые кадры, параметры H.264 и AAC', () async {
      final info = await readMp4(clip);
      final video = info.video!, audio = info.audio!;
      expect(video.samples.length, 150);
      expect(video.samples.first.sync, isTrue);
      expect(video.samples.where((s) => s.sync).length, 6, reason: 'ключевой кадр раз в секунду');
      expect(video.sps.single.first & 31, 7);
      expect(video.pps.single.first & 31, 8);
      expect(video.nalLength, 4);
      expect(audio.sampleRate, 44100);
      expect(audio.channels, 2);
      expect(info.duration, closeTo(6, 0.1));
      // B-кадры: время показа отличается от времени декодирования, но не уходит в минус.
      expect(video.samples.any((s) => s.cts != s.dts), isTrue);
      expect(video.samples.every((s) => s.cts >= s.dts), isTrue);
      // Смещения лежат внутри файла и идут по порядку записи.
      final size = File(clip).lengthSync();
      expect(video.samples.every((s) => s.offset > 0 && s.offset + s.size <= size), isTrue);
      expect(info.configKey, contains('v:'));
    });

    test('moov в конце файла находится; ролик без звука; чужие кодеки отвергаются понятной ошибкой', () async {
      expect((await readMp4(clipB)).video!.samples.length, 100);
      final silent = await readMp4(quiet);
      expect(silent.audio, isNull);
      expect(silent.video, isNotNull);
      await expectLater(readMp4(hevc), throwsA(isA<Mp4Unsupported>().having((e) => e.message, 'text', contains('не H.264'))));
      final junk = File('${dir.path}/junk.mp4')..writeAsBytesSync(List.filled(500, 7));
      await expectLater(readMp4(junk.path), throwsA(isA<Mp4Unsupported>()));
    });

    test('описание AAC: частоты и каналы', () {
      expect(parseAudioSpecificConfig(Uint8List.fromList([0x12, 0x10])), (44100, 2));
      expect(parseAudioSpecificConfig(Uint8List.fromList([0x11, 0x90])), (48000, 2));
      expect(parseAudioSpecificConfig(Uint8List.fromList([0x12, 0x08])), (44100, 1));
    });
  }, skip: _haveTools ? false : 'нужен ffmpeg');

  group('пакеты RTP', () {
    test('крупный кадр режется на FU-A и собирается обратно без потерь', () async {
      final track = Mp4Track(isVideo: true, timescale: 1000, samples: const [], sps: [Uint8List.fromList([0x67, 0x42, 0xc0, 0x1f, 1])], pps: [Uint8List.fromList([0x68, 1, 2])]);
      final idr = Uint8List.fromList([0x65, ...List.generate(5000, (i) => (i * 7) % 251)]);
      final sample = Uint8List.fromList([0, 0, 0x13, 0x89, ...idr]); // длина 5001 = 0x1389
      final payloads = h264Payloads(track, sample, sync: true);
      expect(payloads.first[0] & 31, 7, reason: 'перед ключевым кадром идут SPS и PPS');
      expect(payloads[1][0] & 31, 8);
      final fragments = payloads.skip(2).toList();
      expect(fragments.length, greaterThan(3));
      expect(fragments.every((p) => p.length <= 1200 && (p[0] & 31) == 28), isTrue);
      expect(fragments.first[1] & 0x80, isNot(0), reason: 'начало');
      expect(fragments.last[1] & 0x40, isNot(0), reason: 'конец');
      final rebuilt = BytesBuilder()..addByte((fragments.first[0] & 0xE0) | (fragments.first[1] & 31));
      for (final f in fragments) {
        rebuilt.add(f.sublist(2));
      }
      expect(rebuilt.toBytes(), idr);
      // Не ключевой кадр идёт без параметров, малый — одним пакетом.
      final small = Uint8List.fromList([0, 0, 0, 3, 0x41, 9, 9]);
      expect(h264Payloads(track, small, sync: false), [Uint8List.fromList([0x41, 9, 9])]);
    });

    test('RTP: заголовок, счётчики, метка по времени; AAC и RTCP', () {
      final stream = RtpStream(96, 90000, ssrc: 0x01020304, firstSequence: 65535, firstTimestamp: 1000);
      final first = stream.packet(Uint8List.fromList([1, 2]), stream.timestampFor(1.0), marker: true);
      final second = stream.packet(Uint8List.fromList([3]), stream.timestampFor(1.04), marker: false);
      final a = ByteData.sublistView(first), b = ByteData.sublistView(second);
      expect(first[0], 0x80);
      expect(first[1], 0x80 | 96);
      expect(a.getUint16(2), 65535);
      expect(b.getUint16(2), 0, reason: 'номер пакета переходит через край');
      expect(a.getUint32(4), 1000 + 90000);
      expect(b.getUint32(4), 1000 + 93600);
      expect(a.getUint32(8), 0x01020304);
      expect(second[1], 96);
      final frame = aacPayload(Uint8List.fromList(List.filled(300, 5)));
      expect(ByteData.sublistView(frame).getUint16(0), 16);
      expect(ByteData.sublistView(frame).getUint16(2) >> 3, 300);
      final report = stream.senderReport(DateTime.utc(2026, 10, 3));
      expect(report.length, 28);
      expect(report[1], 200);
      expect(ByteData.sublistView(report).getUint32(20), 2, reason: 'число отправленных пакетов');
    });

    test('описание потока для сервера', () async {
      if (!_haveTools) return;
      final info = await readMp4(clip);
      final sdp = buildSdp(video: info.video, audio: info.audio);
      expect(sdp, contains('m=video 0 RTP/AVP 96'));
      expect(sdp, contains('a=rtpmap:96 H264/90000'));
      expect(sdp, contains('sprop-parameter-sets='));
      expect(sdp, contains('a=rtpmap:97 MPEG4-GENERIC/44100/2'));
      expect(sdp, contains('config=1210'));
      expect(sdp, contains('a=control:streamid=1'));
      expect(buildSdp(video: (await readMp4(quiet)).video), isNot(contains('m=audio')));
    });
  });

  group('эфир на сервер (настоящий MediaMTX)', () {
    late Process mtx;
    late int port;
    late OwnServer server;
    const key = 'phone-test-key';

    setUp(() async {
      port = 49800;
      final config = File('${dir.path}/mtx.yml');
      config.writeAsStringSync([
        'logLevel: error', 'readTimeout: 10s', 'rtspAddress: :$port', 'rtpAddress: :${port + 2}', 'rtcpAddress: :${port + 3}',
        'multicastRTPPort: ${port + 4}', 'multicastRTCPPort: ${port + 5}', 'rtspAuthMethods: [digest]',
        'rtmp: no', 'hls: no', 'webrtc: no', 'srt: no', 'moq: no', 'api: no', 'metrics: no', 'pprof: no', 'playback: no',
        'authInternalUsers:', '- user: any', '  permissions:', '  - action: read', '- user: vrcast', '  pass: $key', '  permissions:', '  - action: publish',
        'paths:', '  phone: {}', ''
      ].join('\n'));
      mtx = await Process.start(_mediamtx!, [config.path]);
      mtx.stdout.drain<void>();
      mtx.stderr.drain<void>();
      for (var i = 0; i < 50; i++) {
        try {
          (await Socket.connect('127.0.0.1', port, timeout: const Duration(milliseconds: 200))).destroy();
          break;
        } catch (_) {
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
      }
      server = OwnServer(name: 'Тест', host: '127.0.0.1', rtspPort: port, key: key);
    });
    tearDown(() async {
      mtx.kill();
      await mtx.exitCode;
    });

    Future<Map<String, dynamic>> probe() async {
      final result = await Process.run('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp', '-show_entries', 'stream=codec_name,codec_type,width,height,sample_rate,channels', '-of', 'json', 'rtsp://127.0.0.1:$port/phone']).timeout(const Duration(seconds: 20));
      return result.exitCode == 0 ? jsonDecode('${result.stdout}') as Map<String, dynamic> : <String, dynamic>{};
    }

    Future<T> eventually<T>(Future<T?> Function() check, String message, {int tries = 60}) async {
      for (var i = 0; i < tries; i++) {
        final value = await check();
        if (value != null) return value;
        await Future<void>.delayed(const Duration(milliseconds: 250));
      }
      fail(message);
    }

    test('файл уходит на сервер, зритель получает H.264 и AAC и может их декодировать; пауза, перемотка, повтор', () async {
      final broadcast = FileBroadcast();
      addTearDown(() async => broadcast.stop());
      await broadcast.start(server, [SharedFile(id: 'a', path: clip, title: 'Клип А'), SharedFile(id: 'b', path: clipB, title: 'Клип Б')]);

      final streams = await eventually(() async {
        final data = await probe();
        return (data['streams'] as List?)?.isNotEmpty == true ? data : null;
      }, 'сервер должен отдавать поток');
      final list = (streams['streams'] as List).cast<Map>();
      expect(list.firstWhere((s) => s['codec_type'] == 'video')['codec_name'], 'h264');
      expect(list.firstWhere((s) => s['codec_type'] == 'video')['width'], 480);
      expect(list.firstWhere((s) => s['codec_type'] == 'audio')['codec_name'], 'aac');
      expect(list.firstWhere((s) => s['codec_type'] == 'audio')['sample_rate'], '44100');
      expect(broadcast.viewLink, 'rtspt://127.0.0.1:$port/phone');

      // Зритель декодирует реальные кадры без ошибок (потерянные пакеты и сломанные NAL дали бы предупреждения).
      final decode = await Process.run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-rtsp_transport', 'tcp', '-i', 'rtsp://127.0.0.1:$port/phone', '-t', '2', '-f', 'null', '-']).timeout(const Duration(seconds: 30));
      expect(decode.exitCode, 0, reason: '${decode.stderr}');
      expect('${decode.stderr}'.toLowerCase(), isNot(contains('error')), reason: '${decode.stderr}');

      expect(broadcast.active && !broadcast.paused, isTrue);
      expect(broadcast.current?.title, 'Клип А');
      expect(broadcast.duration, closeTo(6, 0.2));
      final before = broadcast.position;
      await Future<void>.delayed(const Duration(milliseconds: 1500));
      expect(broadcast.position, greaterThan(before), reason: 'время идёт');

      // Пауза держит позицию, соединение живо; продолжение идёт дальше.
      broadcast.pause();
      await Future<void>.delayed(const Duration(milliseconds: 600));
      final held = broadcast.position;
      await Future<void>.delayed(const Duration(milliseconds: 1500));
      expect(broadcast.position, held);
      broadcast.resume();
      await eventually(() async => broadcast.position > held ? true : null, 'после паузы эфир идёт');

      // Перемотка на ключевой кадр около 4-й секунды.
      broadcast.seek(4.2);
      await eventually(() async => broadcast.position >= 3.9 && broadcast.position < 5.5 ? true : null, 'перемотка вперёд');

      // Следующий файл: тот же формат, переподключения нет, эфир не прерывается.
      broadcast.next();
      await eventually(() async => broadcast.current?.id == 'b' ? true : null, 'переход к следующему');
      expect(broadcast.duration, closeTo(4, 0.2));
      expect((await probe())['streams'], isNotEmpty);

      // «Назад» в начале ролика возвращает на предыдущий файл, после пары секунд — в начало этого.
      broadcast.jump('a');
      await eventually(() async => broadcast.current?.id == 'a' ? true : null, 'переход по номеру');

      broadcast.setLoop('one');
      broadcast.seek(5.0);
      await eventually(() async => broadcast.position < 1.0 && broadcast.current?.id == 'a' ? true : null, 'повтор трека', tries: 80);

      await broadcast.stop();
      expect(broadcast.active, isFalse);
      await eventually(() async => (await probe()).isEmpty ? true : null, 'после остановки поток пропадает');
    }, timeout: const Timeout(Duration(minutes: 3)));

    test('смена формата идёт новым сеансом; ролик без звука; неподдерживаемый файл пропускается; неверный ключ — понятная ошибка', () async {
      final broadcast = FileBroadcast(speedUp: 6);
      addTearDown(() async => broadcast.stop());
      await broadcast.start(server, [SharedFile(id: 'h', path: hevc, title: 'HEVC'), SharedFile(id: 'q', path: quiet, title: 'Без звука'), SharedFile(id: 'a', path: clip, title: 'Со звуком')]);
      await eventually(() async => broadcast.current?.id == 'q' ? true : null, 'HEVC пропущен, идёт следующий');
      expect(broadcast.warning, contains('не H.264'));
      final silent = await eventually(() async {
        final data = await probe();
        final streams = (data['streams'] as List?)?.cast<Map>() ?? const [];
        return streams.length == 1 ? streams : null;
      }, 'ролик без звука отдаётся одним видео');
      expect(silent.single['codec_type'], 'video');
      await eventually(() async => broadcast.current?.id == 'a' ? true : null, 'после ролика без звука идёт ролик со звуком (новый сеанс)', tries: 80);
      final both = await eventually(() async {
        final streams = ((await probe())['streams'] as List?)?.cast<Map>() ?? const [];
        return streams.length == 2 ? streams : null;
      }, 'теперь видео и звук');
      expect(both.map((s) => s['codec_type']).toSet(), {'video', 'audio'});
      await broadcast.stop();

      final wrong = FileBroadcast();
      addTearDown(() async => wrong.stop());
      await wrong.start(OwnServer(name: 'x', host: '127.0.0.1', rtspPort: port, key: 'неверный-ключ'), [SharedFile(id: 'a', path: clip, title: 'А')]);
      await eventually(() async => wrong.active ? null : true, 'с неверным ключом эфир не начинается', tries: 100);
      expect(wrong.error, contains('ключ'));

      final onlyBad = FileBroadcast();
      addTearDown(() async => onlyBad.stop());
      await onlyBad.start(server, [SharedFile(id: 'h', path: hevc, title: 'HEVC')]);
      await eventually(() async => onlyBad.active ? null : true, 'если играть нечего, эфир останавливается');
      expect(onlyBad.error, contains('не H.264'));
    }, timeout: const Timeout(Duration(minutes: 3)));
  }, skip: _haveTools && _mediamtx != null ? false : 'нужны ffmpeg и MediaMTX');
}
