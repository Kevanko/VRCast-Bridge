import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dartssh2/dartssh2.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vrcast_remote/file_broadcast.dart';
import 'package:vrcast_remote/hls.dart';
import 'package:vrcast_remote/media_server.dart';
import 'package:vrcast_remote/ssh_tunnel.dart';

import 'support/local_sshd.dart';

void main() {
  final skip = LocalSshd.available ? false : 'нужен sshd';
  late LocalSshd sshd;
  late HttpServer backend;

  setUpAll(() async {
    if (!LocalSshd.available) return;
    sshd = LocalSshd();
    await sshd.start();
    backend = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    backend.listen((request) async {
      if (request.uri.path == '/big') {
        request.response.add(List<int>.generate(2 * 1024 * 1024, (i) => i % 251));
      } else {
        request.response.write('привет из телефона ${request.uri.path}');
      }
      await request.response.close();
    });
  });
  tearDownAll(() async {
    if (!LocalSshd.available) return;
    await backend.close(force: true);
    await sshd.stop();
  });

  test('адрес из текста сервиса: Serveo с цветами и подсказками, лишние ссылки не путаются', () {
    const banner = '\x1B[32mForwarding HTTP traffic from https://EF46c213c9a99338-104-28-254-16.serveousercontent.com\x1B[0m\r\n'
        '\x1B[33mTip (1): Add your SSH key https://console.serveo.net/ssh/keys?add=SHA256%3AAbc\x1B[0m\r\n';
    expect(tunnelUrlFromBanner(banner, SshTunnel.serveoUrl), 'https://ef46c213c9a99338-104-28-254-16.serveousercontent.com');
    expect(tunnelUrlFromBanner('https://console.serveo.net/ssh/keys', SshTunnel.serveoUrl), isNull);
    expect(tunnelUrlFromBanner('', SshTunnel.serveoUrl), isNull);
  });

  test('одноразовый ключ: создаётся, читается как SSH-ключ, у каждого запуска свой', () {
    final first = generateTunnelKey();
    final second = generateTunnelKey();
    expect(first, contains('BEGIN OPENSSH PRIVATE KEY'));
    expect(first, isNot(second));
    expect(SSHKeyPair.fromPem(first), isNotEmpty);
  });

  test('туннель на настоящем sshd: сгенерированный ключ принимается, запросы снаружи доходят до сервера телефона и ответ возвращается, большой ответ целиком', () async {
    final key = generateTunnelKey();
    sshd.authorize('ssh-ed25519 ${base64.encode(SSHKeyPair.fromPem(key).first.toPublicKey().encode())} vrcast');
    final tunnel = await SshTunnel.start(localPort: backend.port, privateKey: key, host: '127.0.0.1', port: sshd.port, user: sshd.user, remotePort: 0, readUrl: false, name: 'Проверочный');
    addTearDown(tunnel.stop);
    expect(tunnel.url, startsWith('http://127.0.0.1:'));
    expect(tunnel.provider, 'Проверочный');

    final client = HttpClient();
    addTearDown(() => client.close(force: true));
    Future<String> get(String path) async {
      final response = await (await client.getUrl(Uri.parse('${tunnel.url}$path'))).close();
      return utf8.decodeStream(response);
    }

    expect(await get('/страница'), contains('привет из телефона /%D1%81%D1%82%D1%80%D0%B0%D0%BD%D0%B8%D1%86%D0%B0'));
    // Несколько запросов одновременно.
    final many = await Future.wait([for (var i = 0; i < 8; i++) get('/n$i')]);
    for (var i = 0; i < 8; i++) {
      expect(many[i], contains('/n$i'));
    }
    final big = await (await (await client.getUrl(Uri.parse('${tunnel.url}/big'))).close()).fold<int>(0, (n, chunk) => n + chunk.length);
    expect(big, 2 * 1024 * 1024);
    expect(await tunnel.waitServes('/ok', timeout: const Duration(seconds: 5)), isTrue);

    await tunnel.stop();
    await tunnel.closed.timeout(const Duration(seconds: 5));
    expect(await tunnel.waitServes('/ok', timeout: const Duration(seconds: 1)), isFalse, reason: 'после остановки ссылка не отвечает');
  }, skip: skip, timeout: const Timeout(Duration(minutes: 1)));

  test('сервис не пустил (ключ не принят) — понятная ошибка', () async {
    await expectLater(SshTunnel.start(localPort: backend.port, privateKey: generateTunnelKey(), host: '127.0.0.1', port: sshd.port, user: sshd.user, remotePort: 0, readUrl: false),
        throwsA(isA<Object>().having((e) => '$e', 'text', contains('ключ'))));
  }, skip: skip, timeout: const Timeout(Duration(minutes: 1)));

  // Настоящий Serveo: нужен интернет, поэтому вручную. VRCAST_TEST_NET=1
  test('настоящий Serveo: бесплатная ссылка отдаёт HLS с телефона наружу', () async {
    final dir = await Directory.systemTemp.createTemp('vrcast-serveo');
    addTearDown(() => dir.delete(recursive: true));
    final clip = '${dir.path}/clip.mp4';
    final made = await Process.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', clip]);
    expect(made.exitCode, 0);
    final sink = HlsSink(segmentSeconds: 2);
    final server = HlsServer(sink);
    final port = await server.start();
    final broadcast = FileBroadcast(hold: null);
    await broadcast.startSink(sink, '', [SharedFile(id: 'a', path: clip, title: 'Клип')]);
    final tunnel = await SshTunnel.start(localPort: port, privateKey: generateTunnelKey());
    addTearDown(() async {
      await broadcast.stop();
      await tunnel.stop();
      await server.stop();
    });
    expect(tunnel.url, startsWith('https://'));
    expect(tunnel.url, contains('serveousercontent.com'));
    expect(await tunnel.waitServes('/stream/live.m3u8', timeout: const Duration(seconds: 60)), isTrue, reason: 'ссылка должна отдавать плейлист снаружи');
    final probe = await Process.run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'compact', '${tunnel.url}/stream/live.m3u8']).timeout(const Duration(seconds: 60));
    expect('${probe.stdout}', contains('codec_name=h264'), reason: '${probe.stderr}');
  }, skip: Platform.environment['VRCAST_TEST_NET'] == null ? 'задайте VRCAST_TEST_NET=1' : false, timeout: const Timeout(Duration(minutes: 3)));
}
