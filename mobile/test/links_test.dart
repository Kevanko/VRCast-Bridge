import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:vrcast_remote/byte_source.dart';
import 'package:vrcast_remote/file_broadcast.dart';
import 'package:vrcast_remote/links.dart';
import 'package:vrcast_remote/media_server.dart';
import 'package:vrcast_remote/mp4.dart';
import 'package:vrcast_remote/own_server.dart';
import 'package:vrcast_remote/rtsp_session.dart';

bool _has(String name) => Process.runSync('which', [name]).exitCode == 0;
final _tools = _has('ffmpeg') && _has('ffprobe');
final _mediamtx = [
  '${Platform.environment['HOME']}/.local/share/VRCastBridge/tools/mediamtx',
  '${Platform.environment['HOME']}/dev/sample/data/VRCastBridge/tools/mediamtx',
].where((p) => File(p).existsSync()).firstOrNull;

/// Сервер с поддержкой Range: ведёт себя как CDN. [honorRange]=false — как сервер, который отдаёт файл целиком.
class FileServer {
  FileServer(this.file, {this.honorRange = true});
  final File file;
  final bool honorRange;
  late HttpServer server;
  final requests = <String>[];
  int failuresLeft = 0;
  int hangFirst = 0; // сколько первых запросов вообще не отвечать (зависшее соединение)

  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      requests.add('${request.uri.path} ${request.headers.value('range')}');
      if (hangFirst > 0) {
        hangFirst--;
        return; // молчим: ответа не будет
      }
      if (failuresLeft > 0) {
        failuresLeft--;
        request.response.statusCode = 503;
        await request.response.close();
        return;
      }
      final bytes = await file.readAsBytes();
      final match = RegExp(r'bytes=(\d+)-(\d*)').firstMatch(request.headers.value('range') ?? '');
      if (match != null && honorRange) {
        final start = int.parse(match.group(1)!);
        final end = match.group(2)!.isEmpty ? bytes.length - 1 : (int.parse(match.group(2)!)).clamp(0, bytes.length - 1);
        request.response
          ..statusCode = 206
          ..headers.set('content-range', 'bytes $start-$end/${bytes.length}')
          ..add(Uint8List.sublistView(bytes, start, end + 1));
      } else {
        request.response.add(bytes);
      }
      await request.response.close();
    });
  }

  Uri uri(String name) => Uri.parse('http://127.0.0.1:${server.port}/$name');
  Future<void> stop() => server.close(force: true);
}

/// Приёмник без сети: считает, что ему прислали.
class FakeOut implements RtspOut {
  int rtp = 0, rtcp = 0, pings = 0;
  @override
  bool get closed => false;
  @override
  void sendRtp(int track, Uint8List packet) => rtp++;
  @override
  void sendRtcp(int track, Uint8List packet) => rtcp++;
  @override
  Future<void> flush() async {}
  @override
  Future<void> keepAlive() async => pings++;
  @override
  Future<void> close() async {}
}

/// Источник, который в нужный момент надолго замирает (как плохая сеть).
class StallingSource implements ByteSource {
  StallingSource(this.inner, {required this.stallAfter, required this.stall});
  final ByteSource inner;
  final int stallAfter; // после скольких чтений замереть
  final Duration stall;
  int reads = 0;
  @override
  Future<int> length() => inner.length();
  @override
  Future<Uint8List> read(int offset, int length) async {
    if (++reads == stallAfter) await Future<void>.delayed(stall);
    return inner.read(offset, length);
  }

  @override
  Future<void> close() => inner.close();
}

class FakeResolver implements LinkResolver {
  FakeResolver(this.open_);
  final Future<ByteSource> Function(SharedFile) open_;
  @override
  Future<List<LinkInfo>> inspect(String url) => throw UnimplementedError();
  @override
  Future<ByteSource> open(SharedFile item) => open_(item);
}

void main() {
  late Directory dir;
  late File clip;

  setUpAll(() async {
    if (!_tools) return;
    dir = await Directory.systemTemp.createTemp('vrcast-links');
    clip = File('${dir.path}/clip.mp4');
    final made = await Process.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart', '-y', clip.path]);
    expect(made.exitCode, 0);
  });
  tearDownAll(() async {
    if (_tools) await dir.delete(recursive: true);
  });

  group('чтение по сети', () {
    test('куски по Range: чтение через границы блоков совпадает с файлом, лишних запросов нет', () async {
      final data = List<int>.generate(10000, (i) => (i * 31) % 256);
      final file = File('${Directory.systemTemp.path}/vrcast-range-${DateTime.now().microsecondsSinceEpoch}.bin')..writeAsBytesSync(data);
      addTearDown(file.deleteSync);
      final server = FileServer(file);
      await server.start();
      addTearDown(server.stop);
      final source = HttpSource(server.uri('a.bin'), blockSize: 1024);
      expect(await source.length(), 10000);
      expect(await source.read(1000, 100), data.sublist(1000, 1100), reason: 'читаем через границу блоков');
      expect(await source.read(0, 3000), data.sublist(0, 3000));
      expect(await source.read(9990, 100), data.sublist(9990), reason: 'у конца файла отдаётся остаток');
      final before = server.requests.length;
      expect(await source.read(100, 50), data.sublist(100, 150));
      expect(server.requests.length, before, reason: 'уже загруженное повторно не качается');
      await source.close();
    });

    test('сервер не знает Range и отдаёт файл целиком — всё равно читается правильно', () async {
      final data = List<int>.generate(5000, (i) => i % 200);
      final file = File('${Directory.systemTemp.path}/vrcast-norange-${DateTime.now().microsecondsSinceEpoch}.bin')..writeAsBytesSync(data);
      addTearDown(file.deleteSync);
      final server = FileServer(file, honorRange: false);
      await server.start();
      addTearDown(server.stop);
      final source = HttpSource(server.uri('a.bin'), blockSize: 1024);
      expect(await source.length(), 5000);
      expect(await source.read(2500, 200), data.sublist(2500, 2700));
      await source.close();
    });

    test('зависший запрос не тормозит эфир: через короткое время рядом идёт второй, побеждает ответивший', () async {
      final data = List<int>.generate(3000, (i) => i % 100);
      final file = File('${Directory.systemTemp.path}/vrcast-hedge-${DateTime.now().microsecondsSinceEpoch}.bin')..writeAsBytesSync(data);
      addTearDown(file.deleteSync);
      final server = FileServer(file);
      await server.start();
      addTearDown(() => server.stop());
      server.hangFirst = 1;
      final source = HttpSource(server.uri('a.bin'), blockSize: 1024, hedgeAfter: const Duration(milliseconds: 300));
      final watch = Stopwatch()..start();
      expect(await source.read(10, 20), data.sublist(10, 30));
      expect(watch.elapsedMilliseconds, lessThan(3000), reason: 'не ждали таймаут зависшего запроса');
      expect(server.requests.length, greaterThanOrEqualTo(2));
      await source.close();
    });

    test('временный сбой сервера переживается повтором', () async {
      final data = List<int>.generate(3000, (i) => i % 100);
      final file = File('${Directory.systemTemp.path}/vrcast-retry-${DateTime.now().microsecondsSinceEpoch}.bin')..writeAsBytesSync(data);
      addTearDown(file.deleteSync);
      final server = FileServer(file);
      await server.start();
      addTearDown(server.stop);
      server.failuresLeft = 2;
      final source = HttpSource(server.uri('a.bin'), blockSize: 1024);
      expect(await source.read(10, 20), data.sublist(10, 30));
      await source.close();
    });
  });

  group('разбор ссылок', () {
    test('прямая ссылка на mp4: название и длительность берутся из файла; чужие ссылки отвергаются понятно', () async {
      final server = FileServer(clip);
      await server.start();
      addTearDown(server.stop);
      final found = await DefaultLinkResolver().inspect('${server.uri('Мой%20ролик.mp4')}');
      expect(found, hasLength(1));
      expect(found.single.kind, 'direct');
      expect(found.single.title, 'Мой ролик.mp4');
      expect(found.single.duration, closeTo(8, 0.2));
      final item = found.single.toItem();
      expect(item.isLink, isTrue);
      expect(item.path, isEmpty);
      expect(item.toJson()['url'], found.single.url);

      await expectLater(DefaultLinkResolver().inspect('https://vk.com/video-1_2'), throwsA(isA<UnsupportedLink>().having((e) => e.message, 'text', contains('уйдёт на ПК'))));
      await expectLater(DefaultLinkResolver().inspect('это не ссылка'), throwsA(isA<UnsupportedLink>()));
      await expectLater(DefaultLinkResolver().inspect('ftp://x/y.mp4'), throwsA(isA<UnsupportedLink>()));
    }, skip: _tools ? false : 'нужен ffmpeg');

    test('ссылка и файл сохраняются в очереди по-разному и читаются обратно', () {
      final item = SharedFile(id: 'a', path: '', title: 'Клип', url: 'https://youtu.be/x', duration: 61.5, thumbnail: 'https://i.ytimg.com/vi/x/hqdefault.jpg', kind: 'youtube', sourceId: 'x');
      final back = SharedFile.fromJson(item.toJson());
      expect([back.url, back.duration, back.thumbnail, back.kind, back.sourceId, back.isLink], ['https://youtu.be/x', 61.5, 'https://i.ytimg.com/vi/x/hqdefault.jpg', 'youtube', 'x', true]);
      final file = SharedFile(id: 'b', path: '/tmp/b.mp4', title: 'Файл');
      expect(file.toJson().containsKey('url'), isFalse);
      expect(SharedFile.fromJson(file.toJson()).isLink, isFalse);
    });

    test('плейлист: ответ YouTube разбирается в названия, длительность и обложки, лишнее пропускается', () {
      final answer = {
        'contents': {'twoColumnWatchNextResults': {'playlist': {'playlist': {'contents': [
          {'playlistPanelVideoRenderer': {'videoId': 'aaa', 'title': {'simpleText': 'Первый'}, 'lengthText': {'simpleText': '1:27:41'}}},
          {'playlistPanelVideoRenderer': {'videoId': 'bbb', 'title': {'runs': [{'text': 'Вто'}, {'text': 'рой'}]}, 'lengthText': {'simpleText': '3:05'}}},
          {'playlistPanelVideoRenderer': {'videoId': 'ccc', 'title': {'simpleText': 'Без длины'}}},
          {'continuationItemRenderer': {}},
        ]}}}},
      };
      final videos = DefaultLinkResolver.parsePlaylist(answer);
      expect(videos.map((v) => v.title), ['Первый', 'Второй', 'Без длины']);
      expect(videos.map((v) => v.duration), [5261, 185, 0]);
      expect(videos.first.url, 'https://www.youtube.com/watch?v=aaa');
      expect(videos.first.thumbnail, 'https://i.ytimg.com/vi/aaa/hqdefault.jpg');
      expect(videos.every((v) => v.kind == 'youtube'), isTrue);
      expect(DefaultLinkResolver.parsePlaylist({'пусто': []}), isEmpty);
      final many = {'items': [for (var i = 0; i < 300; i++) {'playlistPanelVideoRenderer': {'videoId': 'v$i', 'title': {'simpleText': 't$i'}}}]};
      expect(DefaultLinkResolver.parsePlaylist(many).length, DefaultLinkResolver.maxPlaylist, reason: 'не больше 200 роликов');
    });

    // Настоящий YouTube: нужен интернет, поэтому вручную. VRCAST_TEST_NET=1
    test('YouTube: видео и плейлист разбираются, поток открывается и читается как mp4', () async {
      final resolver = DefaultLinkResolver();
      final video = await resolver.inspect('https://www.youtube.com/watch?v=jNQXAC9IVRw');
      expect(video.single.title, isNotEmpty);
      expect(video.single.duration, greaterThan(10));
      expect(video.single.thumbnail, startsWith('https://i.ytimg.com/'));
      final source = await resolver.open(video.single.toItem());
      final info = await readMp4From(source);
      await source.close();
      expect(info.video, isNotNull);
      expect(info.audio, isNotNull);
      final list = await resolver.inspect('https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI');
      expect(list.length, greaterThan(5));
      expect(list.every((v) => v.kind == 'youtube' && v.title.isNotEmpty), isTrue);
    }, skip: Platform.environment['VRCAST_TEST_NET'] == null ? 'задайте VRCAST_TEST_NET=1' : false, timeout: const Timeout(Duration(minutes: 3)));
  });

  group('эфир ссылки на сервер (настоящий MediaMTX)', () {
    test('ролик по ссылке вещается на сервер с перемоткой по сети', () async {
      final server = FileServer(clip);
      await server.start();
      addTearDown(server.stop);
      const port = 49820;
      final config = File('${dir.path}/mtx.yml')
        ..writeAsStringSync(['logLevel: error', 'rtspAddress: :$port', 'rtpAddress: :${port + 2}', 'rtcpAddress: :${port + 3}', 'multicastRTPPort: ${port + 4}', 'multicastRTCPPort: ${port + 5}', 'rtspAuthMethods: [digest]',
          'rtmp: no', 'hls: no', 'webrtc: no', 'srt: no', 'moq: no', 'api: no', 'metrics: no', 'pprof: no', 'playback: no',
          'authInternalUsers:', '- user: any', '  permissions:', '  - action: read', '- user: vrcast', '  pass: k1', '  permissions:', '  - action: publish', 'paths:', '  phone: {}', ''].join('\n'));
      final mtx = await Process.start(_mediamtx!, [config.path]);
      mtx.stdout.drain<void>();
      mtx.stderr.drain<void>();
      addTearDown(() async {
        mtx.kill();
        await mtx.exitCode;
      });
      for (var i = 0; i < 50; i++) {
        try {
          (await Socket.connect('127.0.0.1', port, timeout: const Duration(milliseconds: 200))).destroy();
          break;
        } catch (_) {
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
      }
      final opened = <Uri>[];
      final broadcast = FileBroadcast(hold: null, resolver: FakeResolver((item) async {
        opened.add(Uri.parse(item.url));
        return HttpSource(server.uri('stream.mp4'), blockSize: 64 * 1024);
      }));
      addTearDown(broadcast.stop);
      final item = SharedFile(id: 'y', path: '', title: 'Видео с YouTube', url: 'https://www.youtube.com/watch?v=abc', duration: 8, kind: 'youtube', sourceId: 'abc');
      await broadcast.start(OwnServer(name: 'Тест', host: '127.0.0.1', rtspPort: port, key: 'k1'), [item]);

      // Асинхронно: синхронный запуск заблокировал бы весь изолят вместе с эфиром.
      Future<Map<String, dynamic>> probe() async {
        final result = await Process.run('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp', '-show_entries', 'stream=codec_name', '-of', 'json', 'rtsp://127.0.0.1:$port/phone']);
        return result.exitCode == 0 ? jsonDecode('${result.stdout}') as Map<String, dynamic> : {};
      }

      Map<String, dynamic> found = {};
      for (var i = 0; i < 60 && (found['streams'] as List?)?.isNotEmpty != true; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 250));
        found = await probe();
      }
      expect((found['streams'] as List).map((s) => s['codec_name']).toSet(), {'h264', 'aac'});
      expect(opened, hasLength(1));
      expect(broadcast.duration, closeTo(8, 0.2));
      // Перемотка по сети: нужные куски запрашиваются по Range, файл целиком заново не качается.
      broadcast.seek(5);
      for (var i = 0; i < 40 && broadcast.position < 4.8; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 250));
      }
      expect(broadcast.position, greaterThanOrEqualTo(4.8));
      expect(server.requests.every((r) => r.contains('bytes=')), isTrue, reason: 'всё читается кусками');
      await broadcast.stop();
    }, skip: _tools && _mediamtx != null ? false : 'нужны ffmpeg и MediaMTX', timeout: const Timeout(Duration(minutes: 2)));

    test('настоящий YouTube: ролик по ссылке вещается на сервер, зритель получает H.264 и AAC', () async {
      const port = 49830;
      final config = File('${dir.path}/mtx-yt.yml')
        ..writeAsStringSync(['logLevel: error', 'rtspAddress: :$port', 'rtpAddress: :${port + 2}', 'rtcpAddress: :${port + 3}', 'multicastRTPPort: ${port + 4}', 'multicastRTCPPort: ${port + 5}', 'rtspAuthMethods: [digest]',
          'rtmp: no', 'hls: no', 'webrtc: no', 'srt: no', 'moq: no', 'api: no', 'metrics: no', 'pprof: no', 'playback: no',
          'authInternalUsers:', '- user: any', '  permissions:', '  - action: read', '- user: vrcast', '  pass: k2', '  permissions:', '  - action: publish', 'paths:', '  phone: {}', ''].join('\n'));
      final mtx = await Process.start(_mediamtx!, [config.path]);
      mtx.stdout.drain<void>();
      mtx.stderr.drain<void>();
      addTearDown(() async {
        mtx.kill();
        await mtx.exitCode;
      });
      for (var i = 0; i < 50; i++) {
        try {
          (await Socket.connect('127.0.0.1', port, timeout: const Duration(milliseconds: 200))).destroy();
          break;
        } catch (_) {
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
      }
      final found = await DefaultLinkResolver().inspect('https://www.youtube.com/watch?v=jNQXAC9IVRw');
      final broadcast = FileBroadcast(hold: null)..setLoop('one'); // ролик короткий: пусть повторяется, пока идёт проверка
      addTearDown(broadcast.stop);
      await broadcast.start(OwnServer(name: 'Тест', host: '127.0.0.1', rtspPort: port, key: 'k2'), [found.single.toItem()]);
      Map<String, dynamic> info = {};
      for (var i = 0; i < 80 && (info['streams'] as List?)?.isNotEmpty != true; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 250));
        final result = await Process.run('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', 'rtsp://127.0.0.1:$port/phone']);
        if (result.exitCode == 0) info = jsonDecode('${result.stdout}') as Map<String, dynamic>;
      }
      expect(broadcast.error, isNull, reason: '${broadcast.warning}');
      expect((info['streams'] as List).map((s) => s['codec_name']).toSet(), {'h264', 'aac'});
      final decode = await Process.run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-rtsp_transport', 'tcp', '-i', 'rtsp://127.0.0.1:$port/phone', '-t', '3', '-f', 'null', '-']).timeout(const Duration(seconds: 40));
      expect(decode.exitCode, 0, reason: '${decode.stderr} | active=${broadcast.active} pos=${broadcast.position} warning=${broadcast.warning} error=${broadcast.error}');
    }, skip: Platform.environment['VRCAST_TEST_NET'] == null || !_tools || _mediamtx == null ? 'задайте VRCAST_TEST_NET=1 (нужны интернет, ffmpeg и MediaMTX)' : false, timeout: const Timeout(Duration(minutes: 3)));

    test('сеть замерла на 13 секунд (дольше таймаута сервера): публикация на настоящем сервере не рвётся и эфир продолжается', () async {
      const port = 49840;
      final config = File('${dir.path}/mtx-stall.yml')
        ..writeAsStringSync(['logLevel: error', 'rtspAddress: :$port', 'rtpAddress: :${port + 2}', 'rtcpAddress: :${port + 3}', 'multicastRTPPort: ${port + 4}', 'multicastRTCPPort: ${port + 5}', 'rtspAuthMethods: [digest]',
          'rtmp: no', 'hls: no', 'webrtc: no', 'srt: no', 'moq: no', 'api: no', 'metrics: no', 'pprof: no', 'playback: no',
          'authInternalUsers:', '- user: any', '  permissions:', '  - action: read', '- user: vrcast', '  pass: k3', '  permissions:', '  - action: publish', 'paths:', '  phone: {}', ''].join('\n'));
      final mtx = await Process.start(_mediamtx!, [config.path]);
      mtx.stdout.drain<void>();
      mtx.stderr.drain<void>();
      addTearDown(() async {
        mtx.kill();
        await mtx.exitCode;
      });
      for (var i = 0; i < 50; i++) {
        try {
          (await Socket.connect('127.0.0.1', port, timeout: const Duration(milliseconds: 200))).destroy();
          break;
        } catch (_) {
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
      }
      var opens = 0;
      final broadcast = FileBroadcast(hold: null, resolver: FakeResolver((item) async {
        opens++;
        return StallingSource(FileSource(clip.path), stallAfter: 14, stall: const Duration(seconds: 13));
      }));
      addTearDown(broadcast.stop);
      await broadcast.start(OwnServer(name: 'x', host: '127.0.0.1', rtspPort: port, key: 'k3'), [SharedFile(id: 'y', path: '', title: 'С провалом сети', url: 'https://example.com/a.mp4', kind: 'direct')]);
      Future<String> describe() async {
        final socket = await Socket.connect('127.0.0.1', port);
        socket.add(utf8.encode('DESCRIBE rtsp://127.0.0.1:$port/phone RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n'));
        final answer = utf8.decode(await socket.first.timeout(const Duration(seconds: 5)));
        socket.destroy();
        return answer;
      }

      // Ждём, пока публикация появится на сервере. Сеть замирает почти сразу после этого (на 14-м чтении) на 13 секунд.
      var answer = '';
      for (var i = 0; i < 80 && !answer.startsWith('RTSP/1.0 200'); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        answer = await describe();
      }
      expect(answer, startsWith('RTSP/1.0 200'), reason: 'публикация должна появиться: $answer');
      // Проверяем в самой глубине провала: от нас нет ни одного кадра больше 10 секунд — таймаута сервера.
      await Future<void>.delayed(const Duration(seconds: 12));
      answer = await describe();
      expect(answer, startsWith('RTSP/1.0 200'), reason: 'сервер не должен закрыть публикацию во время провала сети: $answer');
      expect(broadcast.active, isTrue);
      expect(opens, 1);
    }, skip: _tools && _mediamtx != null ? false : 'нужны ffmpeg и MediaMTX', timeout: const Timeout(Duration(minutes: 2)));

    test('медленная сеть: пока ждём данные, серверу идут отчёты и пинги, соединение не рвётся', () async {
      final out = FakeOut();
      final broadcast = FileBroadcast(hold: null, opener: (url, {required user, required pass, required sdp, required tracks}) async => out, resolver: FakeResolver((item) async {
        // Первые чтения (разбор moov) быстрые, потом сеть замирает на 5 секунд.
        return StallingSource(FileSource(clip.path), stallAfter: 12, stall: const Duration(seconds: 5));
      }));
      addTearDown(broadcast.stop);
      await broadcast.start(OwnServer(name: 'x', host: '127.0.0.1', rtspPort: 9, key: 'k'), [SharedFile(id: 'y', path: '', title: 'Медленное', url: 'https://example.com/a.mp4', kind: 'direct')]);
      while (out.rtp < 5) {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
      final before = out.rtcp;
      await Future<void>.delayed(const Duration(milliseconds: 6000));
      expect(out.rtcp - before, greaterThanOrEqualTo(2), reason: 'во время замирания сервер получает отчёты, иначе через 10 с он закроет публикацию');
      expect(broadcast.active, isTrue);
      expect(broadcast.error, isNull);
    }, skip: _tools ? false : 'нужен ffmpeg', timeout: const Timeout(Duration(minutes: 1)));

    test('ссылка не открылась — пропускается с понятной причиной; все ссылки сломаны — эфир останавливается', () async {
      final broken = FakeResolver((item) async => throw UnsupportedLink('У этого видео нет совместимого потока без ПК'));
      final broadcast = FileBroadcast(hold: null, resolver: broken);
      addTearDown(broadcast.stop);
      await broadcast.start(OwnServer(name: 'x', host: '127.0.0.1', rtspPort: 9, key: 'k'), [SharedFile(id: 'y', path: '', title: 'Закрытое видео', url: 'https://youtu.be/q', kind: 'youtube', sourceId: 'q')]);
      for (var i = 0; i < 40 && broadcast.active; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }
      expect(broadcast.active, isFalse);
      expect(broadcast.error, contains('нет совместимого потока'));
    });
  });
}
