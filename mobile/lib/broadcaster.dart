import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

import 'cloudflare_tunnel.dart';
import 'file_broadcast.dart';
import 'hls.dart';
import 'links.dart';
import 'media_server.dart';
import 'public_tunnel.dart';
import 'remote.dart';
import 'rtsp_server.dart';
import 'ssh.dart';
import 'ssh_tunnel.dart';

/// Эфир с телефона: запуск своей очереди на выбранный способ (локально, бесплатная ссылка, свой сервер) и всё, что
/// телефон для этого держит (RTSP-сервер в сети, HLS с туннелем). Живёт отдельно от связи с ПК: подключились к ПК или
/// отключились — эфир идёт дальше, как музыка в Spotify при смене устройства.
class Broadcaster extends ChangeNotifier {
  Broadcaster({FileBroadcast? files, LinkResolver? resolver, Future<String?> Function()? cloudflared, Future<PublicTunnel> Function(String provider, int localPort)? tunnelStarter})
      : resolver = resolver ?? DefaultLinkResolver(),
        files = files ?? FileBroadcast(resolver: resolver),
        _cloudflared = cloudflared ?? bundledCloudflared,
        _tunnelStarter = tunnelStarter {
    this.files.addListener(_onFiles);
  }

  final FileBroadcast files;
  final LinkResolver resolver;
  final Future<String?> Function() _cloudflared;
  final Future<PublicTunnel> Function(String provider, int localPort)? _tunnelStarter;
  String tunnelName = ''; // каким сервисом поднята бесплатная ссылка сейчас
  bool starting = false; // поднимается раздача (сервер в сети или бесплатная ссылка)
  bool? serves; // бесплатная ссылка отвечает снаружи: null — ещё проверяем
  _Hosted? _hosted;

  void _onFiles() {
    // Эфир кончился — раздача больше не нужна.
    if (!files.active && _hosted != null) unawaited(_stopHosted());
    notifyListeners();
  }

  /// Запустить свою очередь с выбранного ролика на способ из настроек. Возвращает текст ошибки или null.
  Future<String?> start({String? fromId}) async {
    final prefs = Prefs.instance;
    final delivery = prefs.fileDelivery;
    final server = prefs.currentOwnServer;
    if (delivery == 'server' && server == null) return 'Нет своего сервера. Добавьте его в настройках или выберите другой способ.';
    final list = prefs.sharedFiles;
    if (list.isEmpty) return 'Сначала добавьте файлы на вкладке «Очередь».';
    if (starting) return null;
    debugPrint('Эфир своей очереди: способ «$delivery», роликов ${list.length}');
    try {
      final index = fromId == null ? 0 : list.indexWhere((f) => f.id == fromId);
      final from = index < 0 ? 0 : index;
      if (delivery == 'server') {
        await files.stop();
        await _stopHosted();
        await files.start(server!, list, from: from);
        return null;
      }
      return delivery == 'lan' ? await _startLan(list, from) : await _startTunnel(list, from);
    } catch (e) {
      return '$e';
    }
  }

  Future<void> stop() async {
    if (files.active) debugPrint('Эфир своей очереди остановлен');
    await files.stop();
    await _stopHosted();
  }

  /// Локально: телефон сам раздаёт эфир по RTSP, и VRChat на компьютере в той же сети открывает `rtspt://адрес-телефона:порт/live`.
  Future<String?> _startLan(List<SharedFile> list, int from) async {
    await files.stop();
    await _stopHosted();
    starting = true;
    notifyListeners();
    final sink = RtspServerSink();
    try {
      int port;
      try {
        port = await sink.start(port: Prefs.instance.lanPort);
      } on SocketException {
        port = await sink.start(); // порт занят — берём свободный
      }
      final address = (await lanAddresses()).firstOrNull;
      if (address == null) {
        await sink.close();
        return 'Телефон не подключён к сети Wi-Fi: раздавать эфир по сети некому.';
      }
      _hosted = _Hosted(() => sink.close());
      await files.startSink(sink, 'rtspt://$address:$port/live', list, from: from);
      return null;
    } catch (e) {
      await sink.close();
      _hosted = null;
      return '$e';
    } finally {
      starting = false;
      notifyListeners();
    }
  }

  /// Бесплатная ссылка для друзей: телефон сам раздаёт HLS, а туннель (Cloudflare или Serveo) выводит его в интернет.
  /// ПК и свой сервер не нужны. «Авто» пробует Cloudflare, если он есть в сборке, и при неудаче переходит к Serveo.
  Future<String?> _startTunnel(List<SharedFile> list, int from) async {
    final prefs = Prefs.instance;
    await files.stop();
    await _stopHosted();
    starting = true;
    serves = null;
    tunnelName = '';
    notifyListeners();
    final sink = HlsSink();
    final server = HlsServer(sink);
    final problems = <String>[];
    try {
      final port = await server.start();
      final providers = prefs.tunnelProvider == 'auto' ? ['cloudflare', 'serveo'] : [prefs.tunnelProvider];
      PublicTunnel? tunnel;
      for (final provider in providers) {
        try {
          tunnel = await _openTunnel(provider, port);
          break;
        } on CloudflareException catch (e) {
          problems.add(e.message);
        } on SshError catch (e) {
          problems.add(e.message);
        } catch (e) {
          problems.add('$e');
        }
        debugPrint('Бесплатная ссылка: ${problems.last}');
      }
      if (tunnel == null) {
        await server.stop();
        return problems.length == 1 ? problems.single : 'Не удалось поднять ссылку.\n${problems.join('\n')}';
      }
      final started = tunnel;
      tunnelName = started.provider;
      _hosted = _Hosted(() async {
        await started.stop();
        await server.stop();
      }, tunnel: started);
      await files.startSink(sink, '${started.url}/stream/live.m3u8', list, from: from);
      debugPrint('Бесплатная ссылка (${started.provider}): ${started.url}');
      // Туннель упал во время эфира — не делаем вид, что ссылка жива.
      unawaited(started.closed.then((_) {
        if (_hosted?.tunnel == started && files.active) files.fail('Ссылка ${started.provider} оборвалась. Запустите эфир снова.');
      }));
      unawaited(started.waitServes('/stream/live.m3u8', timeout: const Duration(seconds: 45)).then((ok) {
        if (_hosted?.tunnel != started) return;
        serves = ok;
        notifyListeners();
      }));
      return null;
    } catch (e) {
      await server.stop();
      _hosted = null;
      return '$e';
    } finally {
      starting = false;
      notifyListeners();
    }
  }

  Future<PublicTunnel> _openTunnel(String provider, int localPort) async {
    final custom = _tunnelStarter;
    if (custom != null) return custom(provider, localPort);
    if (provider == 'serveo') {
      var key = Prefs.instance.tunnelKey;
      if (key.isEmpty) {
        key = generateTunnelKey();
        Prefs.instance.setTunnelKey(key);
      }
      return SshTunnel.start(localPort: localPort, privateKey: key);
    }
    final binary = await _cloudflared();
    if (binary == null) throw CloudflareException('В этой сборке нет Cloudflare.');
    return CloudflareTunnel.start(binary: binary, localPort: localPort);
  }

  Future<void> _stopHosted() async {
    final hosted = _hosted;
    _hosted = null;
    serves = null;
    await hosted?.stop();
  }

  @override
  void dispose() {
    files.removeListener(_onFiles);
    unawaited(files.stop());
    unawaited(_stopHosted());
    files.dispose();
    super.dispose();
  }
}

class _Hosted {
  _Hosted(this.stop, {this.tunnel});
  final Future<void> Function() stop;
  final PublicTunnel? tunnel;
}
