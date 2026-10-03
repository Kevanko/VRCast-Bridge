import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vrcast_remote/api.dart';
import 'package:vrcast_remote/broadcaster.dart';
import 'package:vrcast_remote/file_broadcast.dart';
import 'package:vrcast_remote/media_server.dart';
import 'package:vrcast_remote/remote.dart';

bool _has(String name) => Process.runSync('which', [name]).exitCode == 0;

void main() {
  late Directory dir;
  late String clip;

  setUpAll(() async {
    if (!_has('ffmpeg')) return;
    dir = await Directory.systemTemp.createTemp('vrcast-rc');
    clip = '${dir.path}/clip.mp4';
    final made = await Process.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', clip]);
    expect(made.exitCode, 0);
  });
  tearDownAll(() async {
    if (_has('ffmpeg')) await dir.delete(recursive: true);
  });

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await Prefs.instance.load();
  });

  String fake(String body) {
    final file = File('${dir.path}/cloudflared${DateTime.now().microsecondsSinceEpoch}')..writeAsStringSync('#!/bin/sh\n$body\n');
    Process.runSync('chmod', ['755', file.path]);
    return file.path;
  }

  Remote remoteWith(Future<String?> Function() cloudflared) =>
      Remote(Api(Uri.parse('http://127.0.0.1:1')), cloudflared: cloudflared, files: FileBroadcast(hold: null));

  Future<void> until(bool Function() check, String message) async {
    for (var i = 0; i < 60; i++) {
      if (check()) return;
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
    fail(message);
  }

  test('бесплатная ссылка: эфир идёт по адресу Cloudflare, после остановки процесс и сервер убираются', () async {
    final pidFile = '${dir.path}/pid';
    final binary = fake('echo \$\$ > $pidFile\necho "INF https://phone-demo.trycloudflare.com" >&2\necho "INF Registered tunnel connection connIndex=0" >&2\nexec sleep 60');
    Prefs.instance.addSharedFiles([SharedFile(id: 'a', path: clip, title: 'Клип')]);
    Prefs.instance.setFileDelivery('tunnel');
    Prefs.instance.setTunnelProvider('cloudflare'); // проверки с подставным cloudflared не должны уходить в настоящий Serveo
    final remote = remoteWith(() async => binary);
    addTearDown(remote.dispose);

    final error = await remote.startFileBroadcast();
    expect(error, isNull);
    expect(remote.cloudStarting, isFalse);
    expect(remote.files.active, isTrue);
    expect(remote.files.viewLink, 'https://phone-demo.trycloudflare.com/stream/live.m3u8');
    final pid = int.parse(File(pidFile).readAsStringSync().trim());
    expect(Process.runSync('kill', ['-0', '$pid']).exitCode, 0, reason: 'cloudflared запущен');
    await until(() => remote.files.position > 0, 'эфир идёт');

    await remote.files.stop();
    await until(() => Process.runSync('kill', ['-0', '$pid']).exitCode != 0, 'после остановки cloudflared должен завершиться');
    expect(remote.cloudServes, isNull);
  }, skip: _has('ffmpeg') ? false : 'нужен ffmpeg', timeout: const Timeout(Duration(minutes: 2)));

  test('ссылка оборвалась во время эфира: эфир останавливается с понятной причиной', () async {
    final binary = fake('echo "INF https://short-lived.trycloudflare.com" >&2\necho "INF Registered tunnel connection" >&2\nsleep 2');
    Prefs.instance.addSharedFiles([SharedFile(id: 'a', path: clip, title: 'Клип')]);
    Prefs.instance.setFileDelivery('tunnel');
    Prefs.instance.setTunnelProvider('cloudflare'); // проверки с подставным cloudflared не должны уходить в настоящий Serveo
    final remote = remoteWith(() async => binary);
    addTearDown(remote.dispose);
    expect(await remote.startFileBroadcast(), isNull);
    await until(() => !remote.files.active, 'эфир должен остановиться, когда туннель упал');
    expect(remote.files.error, contains('оборвалась'));
  }, skip: _has('ffmpeg') ? false : 'нужен ffmpeg', timeout: const Timeout(Duration(minutes: 2)));

  test('ошибки бесплатной ссылки возвращаются текстом, эфир не стартует', () async {
    Prefs.instance.addSharedFiles([SharedFile(id: 'a', path: clip, title: 'Клип')]);
    Prefs.instance.setFileDelivery('tunnel');
    Prefs.instance.setTunnelProvider('cloudflare'); // проверки с подставным cloudflared не должны уходить в настоящий Serveo
    final missing = remoteWith(() async => null);
    addTearDown(missing.dispose);
    expect(await missing.startFileBroadcast(), contains('нет Cloudflare'));
    expect(missing.files.active, isFalse);

    final refused = remoteWith(() async => fake('echo "failed to request quick Tunnel: dial tcp" >&2\nexit 1'));
    addTearDown(refused.dispose);
    expect(await refused.startFileBroadcast(), contains('не выдал ссылку'));
    expect(refused.files.active, isFalse);
    expect(refused.cloudStarting, isFalse);

    Prefs.instance.dropSharedFiles(['a']);
    final empty = remoteWith(() async => fake('sleep 1'));
    addTearDown(empty.dispose);
    expect(await empty.startFileBroadcast(), contains('Сначала добавьте файлы'));
  }, skip: _has('ffmpeg') ? false : 'нужен ffmpeg');

  test('локально: телефон раздаёт эфир по сети, ссылка rtspt://адрес:порт/live открывается, после остановки порт освобождается', () async {
    final addresses = await lanAddresses();
    if (addresses.isEmpty) return; // нет сети Wi-Fi — раздавать некому
    Prefs.instance.addSharedFiles([SharedFile(id: 'a', path: clip, title: 'Клип')]);
    Prefs.instance.setFileDelivery('lan');
    final remote = remoteWith(() async => null);
    addTearDown(remote.dispose);
    expect(await remote.startFileBroadcast(), isNull);
    expect(remote.files.active, isTrue);
    final link = Uri.parse(remote.files.viewLink.replaceFirst('rtspt://', 'http://'));
    expect(link.path, '/live');
    expect(addresses, contains(link.host));
    String described = '';
    for (var i = 0; i < 40 && !described.startsWith('RTSP/1.0 200'); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 250));
      final socket = await Socket.connect('127.0.0.1', link.port);
      socket.add(utf8.encode('DESCRIBE rtsp://127.0.0.1:${link.port}/live RTSP/1.0\r\nCSeq: 1\r\nHost: 127.0.0.1\r\n\r\n'));
      described = utf8.decode(await socket.first.timeout(const Duration(seconds: 5)));
      socket.destroy();
    }
    expect(described, startsWith('RTSP/1.0 200'));
    await remote.files.stop();
    await until(() => remote.cloudServes == null, 'раздача остановлена');
    await Future<void>.delayed(const Duration(milliseconds: 300));
    await expectLater(Socket.connect('127.0.0.1', link.port, timeout: const Duration(seconds: 1)), throwsA(isA<SocketException>()), reason: 'порт освобождён');
  }, skip: _has('ffmpeg') ? false : 'нужен ffmpeg', timeout: const Timeout(Duration(minutes: 1)));

  test('как в Spotify: эфир идёт дальше при смене подключения к ПК — общий эфир не умирает вместе со старым соединением', () async {
    if ((await lanAddresses()).isEmpty) return;
    Prefs.instance.addSharedFiles([SharedFile(id: 'a', path: clip, title: 'Клип')]);
    Prefs.instance.setFileDelivery('lan');
    final broadcaster = Broadcaster(files: FileBroadcast(hold: null));
    addTearDown(broadcaster.dispose);
    final first = Remote.local(broadcaster: broadcaster);
    expect(await first.startFileBroadcast(), isNull);
    expect(broadcaster.files.active, isTrue);
    first.dispose(); // как при подключении к ПК: прежний Remote уничтожается
    await Future<void>.delayed(const Duration(milliseconds: 500));
    expect(broadcaster.files.active, isTrue, reason: 'эфир не прервался');
    final second = Remote(Api(Uri.parse('http://127.0.0.1:1')), broadcaster: broadcaster);
    addTearDown(second.dispose);
    expect(second.files.active, isTrue, reason: 'новое подключение видит тот же эфир');
    expect(second.files.viewLink, startsWith('rtspt://'));
    await second.broadcaster.stop();
    expect(second.files.active, isFalse);
  }, skip: _has('ffmpeg') ? false : 'нужен ffmpeg', timeout: const Timeout(Duration(minutes: 1)));

  test('способ вещания запоминается и по умолчанию — свой сервер', () async {
    expect(Prefs.instance.fileDelivery, 'server');
    Prefs.instance.setFileDelivery('tunnel');
    Prefs.instance.setTunnelProvider('cloudflare'); // проверки с подставным cloudflared не должны уходить в настоящий Serveo
    await Future<void>.delayed(const Duration(milliseconds: 50));
    await Prefs.instance.load();
    expect(Prefs.instance.fileDelivery, 'tunnel');
    Prefs.instance.setFileDelivery('что-то-ещё');
    expect(Prefs.instance.fileDelivery, 'server');
  });
}
