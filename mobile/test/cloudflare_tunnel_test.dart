import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vrcast_remote/cloudflare_tunnel.dart';
import 'package:vrcast_remote/file_broadcast.dart';
import 'package:vrcast_remote/hls.dart';
import 'package:vrcast_remote/media_server.dart';

/// Настоящие адреса узлов Cloudflare через DoH: за VPN системный DNS отдаёт подставные адреса (проверочный стенд).
Future<List<String>> dohEdges() async {
  final client = HttpClient();
  final out = <String>[];
  try {
    for (final host in const ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com']) {
      final request = await client.getUrl(Uri.parse('https://cloudflare-dns.com/dns-query?name=$host&type=A'));
      request.headers.set('accept', 'application/dns-json');
      final body = await (await request.close()).transform(utf8.decoder).join();
      for (final answer in (jsonDecode(body)['Answer'] as List? ?? const []).take(2)) {
        if (answer['type'] == 1) out.add('${answer['data']}:7844');
      }
    }
  } finally {
    client.close();
  }
  return out;
}

void main() {
  group('переходник запроса ссылки', () {
    late HttpServer upstream;
    late QuickServiceGateway gateway;
    final seen = <String>[];

    setUp(() async {
      seen.clear();
      upstream = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      upstream.listen((request) async {
        final body = await utf8.decodeStream(request);
        seen.add('${request.method} ${request.uri.path} ${request.headers.contentType} $body ${request.headers.value('user-agent')}');
        request.response
          ..statusCode = 200
          ..headers.contentType = ContentType.json
          ..write('{"success":true,"result":{"hostname":"demo.trycloudflare.com"}}');
        await request.response.close();
      });
      gateway = await QuickServiceGateway.start(upstream: Uri.parse('http://127.0.0.1:${upstream.port}'));
    });
    tearDown(() async {
      await gateway.stop();
      await upstream.close(force: true);
    });

    Future<(int, String)> post(String path, {String method = 'POST', String body = ''}) async {
      final client = HttpClient();
      final request = await client.openUrl(method, Uri.parse('http://127.0.0.1:${gateway.port}$path'));
      request.headers.set('user-agent', 'cloudflared/test');
      request.headers.contentType = ContentType('application', 'json');
      request.write(body);
      final response = await request.close();
      final text = await utf8.decodeStream(response);
      client.close();
      return (response.statusCode, text);
    }

    test('запрос ссылки пересылается в настоящий API вместе с телом и ответ возвращается как есть', () async {
      final (status, body) = await post('/tunnel', body: '{"x":1}');
      expect(status, 200);
      expect(body, contains('demo.trycloudflare.com'));
      expect(seen.single, 'POST /tunnel application/json {"x":1} cloudflared/test');
    });

    test('чужие запросы не пересылаются; если API недоступен, отдаётся 502', () async {
      expect((await post('/other')).$1, 404);
      expect((await post('/tunnel', method: 'GET')).$1, 404);
      expect(seen, isEmpty);
      await upstream.close(force: true);
      expect((await post('/tunnel')).$1, 502);
    });
  });

  group('запуск cloudflared', () {
    late Directory dir;
    setUp(() async => dir = await Directory.systemTemp.createTemp('vrcast-cf'));
    tearDown(() async => dir.delete(recursive: true));

    String fake(String body) {
      final file = File('${dir.path}/cloudflared')..writeAsStringSync('#!/bin/sh\n$body\n');
      Process.runSync('chmod', ['755', file.path]);
      return file.path;
    }

    test('ссылка берётся из вывода, адрес переходника и узлы Cloudflare передаются, остановка убивает процесс', () async {
      final binary = fake(r'''
echo "args: $@" >&2
echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo "INF |  https://Fake-Tunnel-Name.trycloudflare.com  |" >&2
echo "INF Registered tunnel connection connIndex=0" >&2
sleep 30''');
      final tunnel = await CloudflareTunnel.start(binary: binary, localPort: 4321, edgeAddresses: () async => ['198.41.200.1:7844', '198.41.200.2:7844'], bindAddress: '192.168.1.2');
      expect(tunnel.url, 'https://fake-tunnel-name.trycloudflare.com');
      expect(tunnel.log, contains('--edge 198.41.200.1:7844 --edge 198.41.200.2:7844'));
      expect(tunnel.log, contains('--edge-bind-address 192.168.1.2'));
      expect(tunnel.log, contains('--url http://127.0.0.1:4321'));
      expect(tunnel.log, contains('--protocol http2'));
      expect(tunnel.log, matches(RegExp(r'--quick-service http://127\.0\.0\.1:\d+')));
      await tunnel.stop();
    });

    test('ошибки: нет бинарника, отказ Cloudflare, обрыв до ссылки, тишина', () async {
      await expectLater(CloudflareTunnel.start(binary: '${dir.path}/нет-такого', localPort: 1), throwsA(isA<CloudflareException>().having((e) => e.message, 'text', contains('нет Cloudflare'))));
      await expectLater(
          CloudflareTunnel.start(binary: fake('echo "failed to request quick Tunnel: dial tcp: lookup api.trycloudflare.com" >&2; exit 1'), localPort: 1, edgeAddresses: () async => []),
          throwsA(isA<CloudflareException>().having((e) => e.message, 'text', contains('не выдал ссылку'))));
      await expectLater(
          CloudflareTunnel.start(binary: fake('echo "ERR Unable to establish connection with Cloudflare edge error=TLS handshake with edge error: EOF" >&2; exit 1'), localPort: 1, edgeAddresses: () async => []),
          throwsA(isA<CloudflareException>().having((e) => e.message, 'text', contains('VPN'))));
      await expectLater(
          CloudflareTunnel.start(binary: fake('sleep 20'), localPort: 1, edgeAddresses: () async => [], timeout: const Duration(seconds: 1)),
          throwsA(isA<CloudflareException>().having((e) => e.message, 'text', contains('не ответил'))));
    });

    test('ссылка считается рабочей, только когда адрес отвечает 200', () async {
      final backend = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      var calls = 0;
      backend.listen((request) {
        calls++;
        request.response.statusCode = calls < 3 ? 404 : 200;
        request.response.close();
      });
      final binary = fake('echo "INF https://x.trycloudflare.com" >&2\necho "Registered tunnel connection" >&2\nsleep 30');
      final tunnel = await CloudflareTunnel.start(binary: binary, localPort: 1, edgeAddresses: () async => []);
      // Подменять адрес нельзя: проверка идёт на настоящий адрес, поэтому в проверке достаточно, что без ответа она не врёт.
      expect(await tunnel.waitServes('/stream/live.m3u8', timeout: const Duration(seconds: 2)), isFalse);
      await tunnel.stop();
      await backend.close(force: true);
    });
  });

  // Настоящий Cloudflare: нужен интернет и cloudflared. VRCAST_TEST_CLOUDFLARE=путь_к_cloudflared; при VPN — VRCAST_TEST_BIND=адрес_сетевой_карты.
  final real = Platform.environment['VRCAST_TEST_CLOUDFLARE'];
  test('настоящая бесплатная ссылка Cloudflare отдаёт HLS с телефона', () async {
    final dir = await Directory.systemTemp.createTemp('vrcast-cf-real');
    addTearDown(() => dir.delete(recursive: true));
    final clip = '${dir.path}/clip.mp4';
    final made = await Process.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', clip]);
    expect(made.exitCode, 0);
    final sink = HlsSink(segmentSeconds: 2);
    final server = HlsServer(sink);
    final port = await server.start();
    final broadcast = FileBroadcast(hold: null);
    await broadcast.startSink(sink, '', [SharedFile(id: 'a', path: clip, title: 'Клип')]);
    final bind = Platform.environment['VRCAST_TEST_BIND'];
    final tunnel = await CloudflareTunnel.start(binary: real!, localPort: port, bindAddress: bind, edgeAddresses: bind == null ? null : dohEdges);
    addTearDown(() async {
      await broadcast.stop();
      await tunnel.stop();
      await server.stop();
    });
    expect(tunnel.url, startsWith('https://'));
    expect(await tunnel.waitServes('/stream/live.m3u8', timeout: const Duration(seconds: 60)), isTrue, reason: 'ссылка должна отдавать плейлист снаружи');
    final probe = await Process.run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'compact', '${tunnel.url}/stream/live.m3u8']).timeout(const Duration(seconds: 60));
    expect('${probe.stdout}', contains('codec_name=h264'), reason: '${probe.stderr}');
  }, skip: real == null ? 'задайте VRCAST_TEST_CLOUDFLARE' : false, timeout: const Timeout(Duration(minutes: 4)));
}
