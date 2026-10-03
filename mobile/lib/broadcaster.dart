import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

import 'cloudflare_tunnel.dart';
import 'file_broadcast.dart';
import 'hls.dart';
import 'links.dart';
import 'media_server.dart';
import 'remote.dart';
import 'rtsp_server.dart';

/// Эфир с телефона: запуск своей очереди на выбранный способ (локально, бесплатная ссылка, свой сервер) и всё, что
/// телефон для этого держит (RTSP-сервер в сети, HLS с туннелем). Живёт отдельно от связи с ПК: подключились к ПК или
/// отключились — эфир идёт дальше, как музыка в Spotify при смене устройства.
class Broadcaster extends ChangeNotifier {
  Broadcaster({FileBroadcast? files, LinkResolver? resolver, Future<String?> Function()? cloudflared})
      : resolver = resolver ?? DefaultLinkResolver(),
        files = files ?? FileBroadcast(resolver: resolver),
        _cloudflared = cloudflared ?? bundledCloudflared {
    this.files.addListener(_onFiles);
  }

  final FileBroadcast files;
  final LinkResolver resolver;
  final Future<String?> Function() _cloudflared;
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

  /// Бесплатная ссылка Cloudflare: телефон сам раздаёт HLS, а туннель выводит его в интернет. ПК и сервер не нужны.
  Future<String?> _startTunnel(List<SharedFile> list, int from) async {
    final binary = await _cloudflared();
    if (binary == null) return 'В этой сборке нет Cloudflare. Используйте свой сервер.';
    await files.stop();
    await _stopHosted();
    starting = true;
    serves = null;
    notifyListeners();
    final sink = HlsSink();
    final server = HlsServer(sink);
    CloudflareTunnel? tunnel;
    try {
      final port = await server.start();
      tunnel = await CloudflareTunnel.start(binary: binary, localPort: port);
      final started = tunnel;
      _hosted = _Hosted(() async {
        await started.stop();
        await server.stop();
      }, tunnel: started);
      await files.startSink(sink, '${started.url}/stream/live.m3u8', list, from: from);
      // Туннель упал во время эфира — не делаем вид, что ссылка жива.
      unawaited(started.closed.then((_) {
        if (_hosted?.tunnel == started && files.active) files.fail('Ссылка Cloudflare оборвалась. Запустите эфир снова.');
      }));
      unawaited(started.waitServes('/stream/live.m3u8', timeout: const Duration(seconds: 45)).then((ok) {
        if (_hosted?.tunnel != started) return;
        serves = ok;
        notifyListeners();
      }));
      return null;
    } on CloudflareException catch (e) {
      await server.stop();
      return e.message;
    } catch (e) {
      await tunnel?.stop();
      await server.stop();
      _hosted = null;
      return '$e';
    } finally {
      starting = false;
      notifyListeners();
    }
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
  final CloudflareTunnel? tunnel;
}
