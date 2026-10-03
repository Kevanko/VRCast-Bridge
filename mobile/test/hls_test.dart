import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:vrcast_remote/file_broadcast.dart';
import 'package:vrcast_remote/hls.dart';
import 'package:vrcast_remote/media_server.dart';
import 'package:vrcast_remote/mp4.dart';

bool _has(String name) => Process.runSync('which', [name]).exitCode == 0;
final _tools = _has('ffmpeg') && _has('ffprobe');

void main() {
  late Directory dir;
  late String clip, clipB, music;

  Future<String> make(String name, List<String> args) async {
    final out = '${dir.path}/$name';
    final result = await Process.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-y', out]);
    expect(result.exitCode, 0, reason: '${result.stderr}');
    return out;
  }

  setUpAll(() async {
    if (!_tools) return;
    dir = await Directory.systemTemp.createTemp('vrcast-hls');
    clip = await make('clip.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2']);
    clipB = await make('clipB.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
      '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1']);
    music = await make('music.m4a', ['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100', '-t', '8', '-c:a', 'aac', '-vn']);
  });
  tearDownAll(() async {
    if (_tools) await dir.delete(recursive: true);
  });

  Future<void> until(bool Function() check, String message, {int tries = 80}) async {
    for (var i = 0; i < tries; i++) {
      if (check()) return;
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
    fail(message);
  }

  test('TS: пакеты по 188 байт, синхробайты, непрерывность и PCR на ключевых кадрах', () async {
    final info = await readMp4(clip);
    final writer = TsWriter();
    final tables = writer.tables(video: true, audio: true);
    expect(tables.length, 376, reason: 'PAT и PMT по пакету');
    final sample = info.video!.samples.first;
    final bytes = await File(clip).readAsBytes();
    final frame = Uint8List.sublistView(bytes, sample.offset, sample.offset + sample.size);
    final packets = writer.video(info.video!, frame, pts: 0.08, dts: 0.0, sync: true);
    expect(packets.length % 188, 0);
    for (var i = 0; i < packets.length; i += 188) {
      expect(packets[i], 0x47);
    }
    expect(packets[1] & 0x40, isNot(0), reason: 'начало PES');
    expect(packets[3] >> 4, 3, reason: 'в первом пакете есть поле адаптации с PCR');
    expect(packets[5] & 0x50, 0x50, reason: 'метка произвольного доступа и PCR');
    final counters = [for (var i = 0; i < packets.length; i += 188) packets[i + 3] & 15];
    for (var i = 1; i < counters.length; i++) {
      expect(counters[i], (counters[i - 1] + 1) & 15, reason: 'счётчик непрерывности');
    }
  }, skip: _tools ? false : 'нужен ffmpeg');

  test('HLS: плейлист и сегменты проигрываются; видео и звук на месте; смена файла даёт разрыв; сегменты по ключевым кадрам', () async {
    final sink = HlsSink(segmentSeconds: 2);
    final server = HlsServer(sink);
    final port = await server.start();
    final broadcast = FileBroadcast(hold: null);
    addTearDown(() async {
      await broadcast.stop();
      await server.stop();
    });
    await broadcast.startSink(sink, 'http://127.0.0.1:$port/stream/live.m3u8', [SharedFile(id: 'a', path: clip, title: 'А'), SharedFile(id: 'b', path: clipB, title: 'Б')]);
    expect(broadcast.viewLink, endsWith('/stream/live.m3u8'));

    final client = HttpClient();
    Future<(int, String)> get(String path) async {
      final response = await (await client.getUrl(Uri.parse('http://127.0.0.1:$port$path'))).close();
      final body = await response.transform(const SystemEncoding().decoder).join();
      return (response.statusCode, body);
    }

    expect((await get('/stream/live.m3u8')).$1, 404, reason: 'пока нет сегмента, плейлиста нет');
    await until(() => sink.segments.length >= 2, 'сегменты должны появиться');
    final playlist = (await get('/stream/live.m3u8')).$2;
    expect(playlist, startsWith('#EXTM3U'));
    expect(playlist, contains('#EXT-X-TARGETDURATION:'));
    expect(playlist, contains('seg-0.ts'));
    for (final segment in sink.segments) {
      expect(segment.duration, closeTo(2, 0.15), reason: 'сегмент режется на ключевом кадре около 2 с');
    }
    expect((await get('/stream/seg-9999.ts')).$1, 404);

    // Зритель: ffprobe и полное декодирование без ошибок.
    final probe = await Process.run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,sample_rate,channels', '-of', 'compact', 'http://127.0.0.1:$port/stream/live.m3u8']);
    expect('${probe.stdout}', contains('codec_name=h264'));
    expect('${probe.stdout}', contains('codec_name=aac'));
    expect('${probe.stdout}', contains('width=480'));
    final decode = await Process.run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-i', 'http://127.0.0.1:$port/stream/live.m3u8', '-t', '3', '-f', 'null', '-']).timeout(const Duration(seconds: 30));
    expect(decode.exitCode, 0, reason: '${decode.stderr}');
    expect('${decode.stderr}'.toLowerCase(), isNot(contains('error')), reason: '${decode.stderr}');
    expect('${decode.stderr}'.toLowerCase(), isNot(contains('corrupt')), reason: '${decode.stderr}');

    // Переход к другому файлу (другое разрешение, моно, 48 кГц): в плейлисте разрыв, и поток продолжает играть.
    broadcast.next();
    await until(() => broadcast.current?.id == 'b', 'следующий файл');
    await until(() => sink.segments.any((s) => s.discontinuity) && sink.segments.last.sequence > 2, 'после смены файла появляется разрыв');
    expect((await get('/stream/live.m3u8')).$2, contains('#EXT-X-DISCONTINUITY'));
    final after = await Process.run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width', '-of', 'compact', 'http://127.0.0.1:$port/stream/live.m3u8']);
    expect('${after.stdout}', contains('codec_name=h264'));
    final seqs = sink.segments.map((s) => s.sequence).toList();
    for (var i = 1; i < seqs.length; i++) {
      expect(seqs[i], seqs[i - 1] + 1, reason: 'номера сегментов идут подряд');
    }
    expect(sink.segments.length, lessThanOrEqualTo(6), reason: 'память не растёт: держим последние сегменты');
    client.close(force: true);
  }, timeout: const Timeout(Duration(minutes: 2)), skip: _tools ? false : 'нужен ffmpeg');

  test('HLS: аудиофайл без видео тоже идёт (часы потока ведёт звук)', () async {
    final sink = HlsSink(segmentSeconds: 2);
    final server = HlsServer(sink);
    final port = await server.start();
    final broadcast = FileBroadcast(hold: null);
    addTearDown(() async {
      await broadcast.stop();
      await server.stop();
    });
    await broadcast.startSink(sink, 'x', [SharedFile(id: 'm', path: music, title: 'Музыка')]);
    await until(() => sink.segments.length >= 2, 'сегменты звука');
    final probe = await Process.run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'compact', 'http://127.0.0.1:$port/stream/live.m3u8']);
    expect('${probe.stdout}', contains('codec_name=aac'));
    expect('${probe.stdout}', isNot(contains('codec_type=video')));
    final decode = await Process.run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-i', 'http://127.0.0.1:$port/stream/live.m3u8', '-t', '2', '-f', 'null', '-']).timeout(const Duration(seconds: 30));
    expect(decode.exitCode, 0, reason: '${decode.stderr}');
    expect('${decode.stderr}'.toLowerCase(), isNot(contains('error')), reason: '${decode.stderr}');
  }, timeout: const Timeout(Duration(minutes: 2)), skip: _tools ? false : 'нужен ffmpeg');
}
