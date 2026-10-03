import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vrcast_remote/broadcaster.dart';
import 'package:vrcast_remote/cloudflare_tunnel.dart';
import 'package:vrcast_remote/file_broadcast.dart';
import 'package:vrcast_remote/media_server.dart';
import 'package:vrcast_remote/public_tunnel.dart';
import 'package:vrcast_remote/remote.dart';
import 'package:vrcast_remote/ssh.dart';

bool _has(String name) => Process.runSync('which', [name]).exitCode == 0;

class FakeTunnel extends PublicTunnel {
  FakeTunnel(this.provider, this.url);
  @override
  final String provider;
  @override
  final String url;
  final _closed = Completer<void>();
  @override
  Future<void> get closed => _closed.future;
  void drop() => _closed.complete();
  @override
  Future<void> stop() async {
    markStopped();
    if (!_closed.isCompleted) _closed.complete();
  }

  @override
  Future<bool> waitServes(String path, {Duration timeout = const Duration(seconds: 30)}) async => true;
}

void main() {
  late Directory dir;
  late String clip;

  setUpAll(() async {
    if (!_has('ffmpeg')) return;
    dir = await Directory.systemTemp.createTemp('vrcast-bc');
    clip = '${dir.path}/clip.mp4';
    final made = await Process.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', clip]);
    expect(made.exitCode, 0);
  });
  tearDownAll(() async {
    if (_has('ffmpeg')) await dir.delete(recursive: true);
  });

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await Prefs.instance.load();
    Prefs.instance.setFileDelivery('tunnel');
  });

  Broadcaster make(Future<PublicTunnel> Function(String, int) starter) => Broadcaster(files: FileBroadcast(hold: null), tunnelStarter: starter);

  Future<void> until(bool Function() check, String message) async {
    for (var i = 0; i < 60; i++) {
      if (check()) return;
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    fail(message);
  }

  test('авто: Cloudflare не поднялся — ссылка берётся у Serveo; в эфире видно, каким сервисом', () async {
    Prefs.instance.addSharedFiles([SharedFile(id: 'a', path: clip, title: 'Клип')]);
    final asked = <String>[];
    final broadcaster = make((provider, port) async {
      asked.add(provider);
      if (provider == 'cloudflare') throw CloudflareException('Не удалось подключиться к Cloudflare (возможно, мешает VPN).');
      return FakeTunnel('Serveo', 'https://demo.serveousercontent.com');
    });
    addTearDown(broadcaster.dispose);
    expect(await broadcaster.start(), isNull);
    expect(asked, ['cloudflare', 'serveo']);
    expect(broadcaster.tunnelName, 'Serveo');
    expect(broadcaster.files.viewLink, 'https://demo.serveousercontent.com/stream/live.m3u8');
    expect(broadcaster.files.active, isTrue);
    await until(() => broadcaster.serves == true, 'ссылка проверена снаружи');
  }, skip: _has('ffmpeg') ? false : 'нужен ffmpeg');

  test('выбран один сервис — пробуется только он; ошибка возвращается как есть; оба упали — видно обе причины', () async {
    Prefs.instance.addSharedFiles([SharedFile(id: 'a', path: clip, title: 'Клип')]);
    final asked = <String>[];
    final broadcaster = make((provider, port) async {
      asked.add(provider);
      throw SshError('$provider недоступен');
    });
    addTearDown(broadcaster.dispose);
    Prefs.instance.setTunnelProvider('serveo');
    expect(await broadcaster.start(), 'serveo недоступен');
    expect(asked, ['serveo']);
    expect(broadcaster.files.active, isFalse);
    expect(broadcaster.starting, isFalse);

    asked.clear();
    Prefs.instance.setTunnelProvider('auto');
    final message = await broadcaster.start();
    expect(asked, ['cloudflare', 'serveo']);
    expect(message, allOf(contains('cloudflare недоступен'), contains('serveo недоступен')));
  }, skip: _has('ffmpeg') ? false : 'нужен ffmpeg');

  test('ссылка оборвалась во время эфира — эфир останавливается и называет сервис; остановка эфира закрывает туннель', () async {
    Prefs.instance.addSharedFiles([SharedFile(id: 'a', path: clip, title: 'Клип')]);
    late FakeTunnel tunnel;
    final broadcaster = make((provider, port) async => tunnel = FakeTunnel('Serveo', 'https://x.serveousercontent.com'));
    addTearDown(broadcaster.dispose);
    Prefs.instance.setTunnelProvider('serveo');
    expect(await broadcaster.start(), isNull);
    await until(() => broadcaster.files.position > 0, 'эфир идёт');
    tunnel.drop();
    await until(() => !broadcaster.files.active, 'эфир должен остановиться');
    expect(broadcaster.files.error, contains('Serveo оборвалась'));

    expect(await broadcaster.start(), isNull);
    final second = tunnel;
    await broadcaster.stop();
    expect(second.stopped, isTrue, reason: 'остановили эфир — туннель закрыт');
  }, skip: _has('ffmpeg') ? false : 'нужен ffmpeg', timeout: const Timeout(Duration(minutes: 1)));

  test('выбор сервиса запоминается, ключ для Serveo создаётся один раз', () async {
    expect(Prefs.instance.tunnelProvider, 'auto');
    Prefs.instance.setTunnelProvider('serveo');
    Prefs.instance.setTunnelKey('KEY');
    await Future<void>.delayed(const Duration(milliseconds: 50));
    await Prefs.instance.load();
    expect(Prefs.instance.tunnelProvider, 'serveo');
    expect(Prefs.instance.tunnelKey, 'KEY');
    Prefs.instance.setTunnelProvider('localhost.run');
    expect(Prefs.instance.tunnelProvider, 'auto', reason: 'неизвестное значение — «Авто»');
  });
}
