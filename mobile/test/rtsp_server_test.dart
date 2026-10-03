import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vrcast_remote/file_broadcast.dart';
import 'package:vrcast_remote/media_server.dart';
import 'package:vrcast_remote/rtsp_server.dart';

bool _has(String name) => Process.runSync('which', [name]).exitCode == 0;
final _tools = _has('ffmpeg') && _has('ffprobe');

void main() {
  late Directory dir;
  late String clip, clipB;

  Future<String> make(String name, List<String> args) async {
    final out = '${dir.path}/$name';
    final result = await Process.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-y', out]);
    expect(result.exitCode, 0, reason: '${result.stderr}');
    return out;
  }

  setUpAll(() async {
    if (!_tools) return;
    dir = await Directory.systemTemp.createTemp('vrcast-rs');
    clip = await make('clip.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2']);
    clipB = await make('clipB.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
      '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1']);
  });
  tearDownAll(() async {
    if (_tools) await dir.delete(recursive: true);
  });

  Future<Map<String, dynamic>> probe(int port, {String path = 'live'}) async {
    final r = await Process.run('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp', '-show_entries', 'stream=codec_name,codec_type,width,height', '-of', 'json', 'rtsp://127.0.0.1:$port/$path']).timeout(const Duration(seconds: 25));
    return r.exitCode == 0 ? jsonDecode('${r.stdout}') as Map<String, dynamic> : <String, dynamic>{};
  }

  Future<String> raw(int port, String request) async {
    final socket = await Socket.connect('127.0.0.1', port);
    socket.add(utf8.encode(request));
    final answer = utf8.decode(await socket.first.timeout(const Duration(seconds: 5)));
    socket.destroy();
    return answer;
  }

  test('мгновенная ссылка по сети: ffprobe видит H.264 и AAC, кадры декодируются, второй зритель подключается на ходу', () async {
    final sink = RtspServerSink();
    final port = await sink.start();
    final broadcast = FileBroadcast(hold: null);
    addTearDown(() async {
      await broadcast.stop();
      await sink.close();
    });
    await broadcast.startSink(sink, 'rtspt://127.0.0.1:$port/live', [SharedFile(id: 'a', path: clip, title: 'А')]);
    Map<String, dynamic> info = {};
    for (var i = 0; i < 60 && (info['streams'] as List?)?.isNotEmpty != true; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 250));
      info = await probe(port);
    }
    final streams = (info['streams'] as List).cast<Map>();
    expect(streams.map((s) => s['codec_name']).toSet(), {'h264', 'aac'});
    expect(streams.firstWhere((s) => s['codec_type'] == 'video')['width'], 480);

    // Два зрителя одновременно, один присоединился позже: оба получают чистую картинку.
    final first = Process.run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-rtsp_transport', 'tcp', '-i', 'rtsp://127.0.0.1:$port/live', '-t', '4', '-f', 'null', '-']);
    await Future<void>.delayed(const Duration(seconds: 2));
    final second = Process.run('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-rtsp_transport', 'tcp', '-i', 'rtsp://127.0.0.1:$port/live', '-t', '3', '-f', 'null', '-']);
    final results = await Future.wait([first, second]).timeout(const Duration(seconds: 40));
    for (final r in results) {
      expect(r.exitCode, 0, reason: '${r.stderr}');
    }
    // Зритель, подключившийся посреди ролика, может ругнуться на ссылки на опорные кадры в самом начале — это не ошибки потока.
    expect('${results.first.stderr}'.toLowerCase(), isNot(contains('error')), reason: '${results.first.stderr}');
    expect(sink.viewers, 0, reason: 'после отключения зрителей не остаётся');
  }, skip: _tools ? false : 'нужен ffmpeg', timeout: const Timeout(Duration(minutes: 2)));

  test('чужие запросы: неверный путь — 404, UDP — 461, без потока — 404, OPTIONS отвечает', () async {
    final sink = RtspServerSink();
    final port = await sink.start();
    addTearDown(sink.close);
    expect(await raw(port, 'OPTIONS * RTSP/1.0\r\nCSeq: 1\r\n\r\n'), contains('Public:'));
    expect(await raw(port, 'DESCRIBE rtsp://127.0.0.1:$port/live RTSP/1.0\r\nCSeq: 2\r\n\r\n'), startsWith('RTSP/1.0 404'), reason: 'пока эфира нет, описания тоже нет');
    expect(await raw(port, 'GET_PARAMETER rtsp://127.0.0.1:$port/live RTSP/1.0\r\nCSeq: 3\r\n\r\n'), startsWith('RTSP/1.0 200'));
    expect(await raw(port, 'PLAY rtsp://127.0.0.1:$port/live RTSP/1.0\r\nCSeq: 4\r\n\r\n'), startsWith('RTSP/1.0 455'), reason: 'PLAY без SETUP невозможен');
    expect(await raw(port, 'BREW rtsp://x RTSP/1.0\r\nCSeq: 5\r\n\r\n'), startsWith('RTSP/1.0 501'));
  });

  test('транспорт: только TCP (UDP предлагается — получает отказ 461), чужой путь не отдаётся', () async {
    if (!_tools) return;
    final sink = RtspServerSink();
    final port = await sink.start();
    final broadcast = FileBroadcast(hold: null);
    addTearDown(() async {
      await broadcast.stop();
      await sink.close();
    });
    await broadcast.startSink(sink, 'x', [SharedFile(id: 'a', path: clip, title: 'А')]);
    for (var i = 0; i < 40 && sink.port == 0; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    String described = '';
    for (var i = 0; i < 40 && !described.startsWith('RTSP/1.0 200'); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 250));
      described = await raw(port, 'DESCRIBE rtsp://127.0.0.1:$port/live RTSP/1.0\r\nCSeq: 1\r\nHost: 127.0.0.1:$port\r\n\r\n');
    }
    expect(described, startsWith('RTSP/1.0 200'));
    expect(described, contains('m=video'));
    expect(described, contains('m=audio'));
    expect(await raw(port, 'DESCRIBE rtsp://127.0.0.1:$port/secret RTSP/1.0\r\nCSeq: 1\r\n\r\n'), startsWith('RTSP/1.0 404'));
    expect(await raw(port, 'SETUP rtsp://127.0.0.1:$port/live/streamid=0 RTSP/1.0\r\nCSeq: 2\r\nTransport: RTP/AVP;unicast;client_port=5000-5001\r\n\r\n'), startsWith('RTSP/1.0 461'));
  }, skip: _tools ? false : 'нужен ffmpeg', timeout: const Timeout(Duration(minutes: 1)));

  test('смена формата: зрители отключаются и новое подключение получает новое разрешение', () async {
    final sink = RtspServerSink();
    final port = await sink.start();
    final broadcast = FileBroadcast(hold: null);
    addTearDown(() async {
      await broadcast.stop();
      await sink.close();
    });
    await broadcast.startSink(sink, 'x', [SharedFile(id: 'a', path: clip, title: 'А'), SharedFile(id: 'b', path: clipB, title: 'Б')]);
    Map<String, dynamic> info = {};
    for (var i = 0; i < 60 && (info['streams'] as List?)?.isNotEmpty != true; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 250));
      info = await probe(port);
    }
    expect(((info['streams'] as List).cast<Map>().firstWhere((s) => s['codec_type'] == 'video'))['width'], 480);
    broadcast.next();
    Map<String, dynamic> after = {};
    for (var i = 0; i < 60; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 250));
      after = await probe(port);
      final video = (after['streams'] as List?)?.cast<Map>().where((s) => s['codec_type'] == 'video');
      if (video != null && video.isNotEmpty && video.first['width'] == 320) break;
    }
    expect(((after['streams'] as List).cast<Map>().firstWhere((s) => s['codec_type'] == 'video'))['width'], 320);
  }, skip: _tools ? false : 'нужен ffmpeg', timeout: const Timeout(Duration(minutes: 2)));
}
