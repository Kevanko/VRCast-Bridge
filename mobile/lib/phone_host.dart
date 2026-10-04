import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:nsd/nsd.dart' as nsd;

import 'broadcaster.dart';
import 'file_broadcast.dart' show holdAwake;
import 'links.dart';
import 'media_server.dart';
import 'own_server.dart';
import 'remote.dart';

/// Привязанное к этому устройству другое устройство (хранится только хеш ключа).
class HostDevice {
  HostDevice({required this.id, required this.name, required this.kind, required this.hash, required this.at});
  final String id;
  String name;
  final String kind; // 'phone' | 'pc'
  final String hash;
  final DateTime at;

  Map<String, Object?> toJson() => {'id': id, 'name': name, 'kind': kind, 'hash': hash, 'at': at.toIso8601String()};
  factory HostDevice.fromJson(Map<String, dynamic> json) => HostDevice(
        id: '${json['id']}',
        name: '${json['name'] ?? 'Устройство'}',
        kind: json['kind'] == 'pc' ? 'pc' : 'phone',
        hash: '${json['hash']}',
        at: DateTime.tryParse('${json['at']}') ?? DateTime.now(),
      );
}

class _Member {
  _Member(this.device);
  final HostDevice device;
  String base = '';
  String key = '';
  List<SharedFile> files = [];
  List<OwnServer> servers = [];
  final Set<String> removed = {}; // файлы, которые админ убрал из общей очереди
  int streams = 0; // открытых потоков событий: пока есть, устройство в сети
  Timer? drop;
}

class _Listener {
  _Listener(this.response, this.memberId);
  final HttpResponse response;
  final String memberId;
}

/// Это устройство как админ группы: к нему подключаются другие устройства (телефоны и ПК), тот же протокол, что у ПК.
/// Общая очередь — свои ролики плюс файлы участников, пока те в сети. Эфир один, ведёт тот, кто начал последним.
class PhoneHost extends ChangeNotifier {
  PhoneHost({required this.broadcaster, this.graceMs = 15000, this.heartbeat = const Duration(seconds: 2), this.resolver, this.advertise = true});

  final Broadcaster broadcaster;
  final int graceMs;
  final Duration heartbeat; // как часто проверяем, что подключённые устройства ещё на связи
  final LinkResolver? resolver;
  final bool advertise;

  /// Единственный на приложение: настройки находят его здесь.
  static PhoneHost? current;

  HttpServer? _server;
  nsd.Registration? _registration;
  final _members = <String, _Member>{};
  final _listeners = <_Listener>[];
  Timer? _pushTimer;
  Timer? _tick;
  String _lastSent = '';
  ({String id, String name, String kind})? controller;
  String pairCode = '';

  bool get running => _server != null;
  int? get port => _server?.port;
  Prefs get _prefs => Prefs.instance;

  List<HostDevice> get devices => _prefs.hostDevices;
  bool isOnline(String id) => (_members[id]?.streams ?? 0) > 0;
  int filesOf(String id) => _members[id]?.files.length ?? 0;

  static String _random(int bytes) => base64Url.encode(List.generate(bytes, (_) => Random.secure().nextInt(256))).replaceAll('=', '');
  static String _hash(String token) => sha256.convert(utf8.encode(token)).toString();

  Future<void> setEnabled(bool on) async {
    _prefs.update(() => _prefs.hostEnabled = on);
    on ? await start() : await stop();
  }

  /// Порт сменили: устройство сразу слушает на новом, без перезапуска приложения. Подключённым придётся найти его заново.
  Future<void> changePort(int port) async {
    _prefs.update(() => _prefs.hostPort = port);
    if (running) {
      await stop();
      await start();
    }
  }

  void rotateCode() {
    pairCode = (100000 + Random.secure().nextInt(900000)).toString();
    notifyListeners();
  }

  Future<int> start({int? port}) async {
    if (_server != null) return _server!.port;
    if (_prefs.hostId.isEmpty) _prefs.update(() => _prefs.hostId = _random(6));
    rotateCode();
    final server = _server = await HttpServer.bind(InternetAddress.anyIPv4, port ?? _prefs.hostPort, shared: true);
    server.listen(_handle, onError: (_) {});
    broadcaster.addListener(_changed);
    _prefs.addListener(_changed);
    _tick = Timer.periodic(heartbeat, (_) {
      // Пустая строка потока: по ней видно, что устройство отвалилось (запись в закрытое соединение не проходит).
      for (final listener in List.of(_listeners)) {
        try {
          listener.response.write(': \n\n');
        } catch (_) {
          _listeners.remove(listener);
        }
      }
      if (broadcaster.files.active) _push();
    });
    _syncQueue();
    if (advertise) {
      // Админ группы должен жить и при свёрнутом приложении: держим службу переднего плана.
      unawaited(holdAwake(true, who: 'host'));
      unawaited(_register(server.port));
    }
    notifyListeners();
    return server.port;
  }

  Future<void> _register(int port) async {
    try {
      _registration = await nsd.register(nsd.Service(
        name: _prefs.deviceName,
        type: '_vrcast._tcp',
        port: port,
        txt: {'name': Uint8List.fromList(utf8.encode(_prefs.deviceName)), 'ver': Uint8List.fromList(utf8.encode('phone'))},
      ));
    } catch (_) {
      // Без объявления устройство всё равно доступно по адресу.
    }
  }

  Future<void> stop() async {
    final server = _server;
    if (server == null) return;
    _server = null;
    broadcaster.removeListener(_changed);
    _prefs.removeListener(_changed);
    _tick?.cancel();
    _pushTimer?.cancel();
    if (advertise) unawaited(holdAwake(false, who: 'host'));
    for (final member in _members.values) {
      member.drop?.cancel();
    }
    _members.clear();
    broadcaster.extraFiles = const [];
    for (final listener in List.of(_listeners)) {
      try {
        await listener.response.close();
      } catch (_) {}
    }
    _listeners.clear();
    final registration = _registration;
    _registration = null;
    if (registration != null) {
      try {
        await nsd.unregister(registration);
      } catch (_) {}
    }
    await server.close(force: true);
    notifyListeners();
  }

  /// Отвязать устройство: оно теряет доступ, его файлы и серверы пропадают из общей очереди.
  void unpair(String id) {
    _prefs.update(() => _prefs.hostDevices = _prefs.hostDevices.where((d) => d.id != id).toList());
    _dropMember(id);
  }

  void unpairAll() {
    for (final device in List.of(_prefs.hostDevices)) {
      _dropMember(device.id);
    }
    _prefs.update(() => _prefs.hostDevices = []);
    rotateCode();
  }

  void rename(String id, String name) {
    final device = _prefs.hostDevices.where((d) => d.id == id).firstOrNull;
    if (device == null || name.trim().isEmpty) return;
    _prefs.update(() => device.name = name.trim());
  }

  // ── Группа ──

  _Member? _memberFor(HttpRequest request) {
    final token = request.headers.value('x-vrcast-token');
    if (token == null || token.isEmpty) return null;
    final hash = _hash(token);
    final device = _prefs.hostDevices.where((d) => d.hash == hash).firstOrNull;
    return device == null ? null : _members.putIfAbsent(device.id, () => _Member(device));
  }

  void _dropMember(String id) {
    final member = _members.remove(id);
    member?.drop?.cancel();
    if (controller?.id == id) controller = null;
    _syncQueue();
    _changed();
  }

  /// Очередь для эфира: свои ролики и файлы участников. Файл участника играется по сети с его устройства.
  void _syncQueue() {
    broadcaster.extraFiles = [
      for (final member in _members.values)
        for (final file in member.files)
          if (member.base.isNotEmpty)
            SharedFile(
                id: '${member.device.id}.${file.id}',
                path: '',
                title: file.title,
                url: file.isLink ? file.url : '${member.base}/api/media/${Uri.encodeComponent(file.id)}?k=${member.key}',
                duration: file.duration,
                thumbnail: file.thumbnail,
                kind: file.isLink ? file.kind : 'direct',
                sourceId: file.sourceId),
    ];
  }

  String ownerName(String id) => _ownerOf(id);

  String _ownerOf(String id) {
    final dot = id.indexOf('.');
    if (dot < 0) return '';
    return _members[id.substring(0, dot)]?.device.name ?? '';
  }

  void _changed() {
    if (_server == null) return;
    notifyListeners();
    _pushTimer ??= Timer(const Duration(milliseconds: 250), () {
      _pushTimer = null;
      _push();
    });
  }

  void _push() {
    if (_server == null || _listeners.isEmpty) return;
    final text = jsonEncode(state());
    // Позиция в состояние входит, поэтому «то же самое» значит: ничего не изменилось и эфир не идёт.
    if (text == _lastSent && !broadcaster.files.active) return;
    _lastSent = text;
    for (final listener in List.of(_listeners)) {
      try {
        listener.response.write('data: $text\n\n');
      } catch (_) {
        _listeners.remove(listener);
      }
    }
  }

  void _lead(_Member? member) {
    if (member != null) controller = (id: member.device.id, name: member.device.name, kind: member.device.kind);
  }

  // ── Состояние в формате ПК ──

  Map<String, Object?> state() {
    final files = broadcaster.files;
    final prefs = _prefs;
    final all = [...prefs.sharedFiles, ...broadcaster.extraFiles];
    final current = files.current;
    final delivery = prefs.fileDelivery;
    return {
      'running': files.active,
      'activeKind': files.active ? 'queue' : '',
      'currentId': current?.id ?? '',
      'phoneSource': false,
      'queue': [
        for (final item in all)
          {
            'id': item.id,
            'title': item.title,
            'duration': item.duration,
            'thumbnail': item.thumbnail,
            'unavailable': false,
            if (item.id.contains('.') && !prefs.sharedFiles.any((f) => f.id == item.id))
              ...{'owner': _ownerOf(item.id), 'member': item.id.split('.').first, 'ownerItemId': item.id.substring(item.id.indexOf('.') + 1)},
          }
      ],
      'progress': {'elapsed': files.position, 'duration': files.duration},
      'playback': {
        'paused': files.paused,
        'buffering': files.connecting,
        'busy': broadcaster.starting,
        'canSeek': files.active && files.duration > 0,
        'speed': prefs.playSpeed,
        'loopMode': files.loopMode,
      },
      'stream': {'ready': files.active && !files.connecting},
      'playbackUrl': files.viewLink,
      'rtsp': {'lanUrls': const <String>[]},
      'tunnel': {'url': delivery == 'tunnel' ? files.viewLink.replaceAll('/stream/live.m3u8', '') : '', 'state': broadcaster.serves == true ? 'ready' : ''},
      'config': {
        'outputMode': delivery == 'lan' ? 'local' : delivery == 'tunnel' ? 'tunnel' : 'remote',
        'tunnelProvider': prefs.tunnelProvider,
        'quality': prefs.videoQuality == 'copy' ? '720p' : prefs.videoQuality,
        'fps': prefs.videoFps,
        'encoderMode': 'auto',
        'activeServerId': prefs.ownServerId ?? '',
        'whiteIp': '',
        'mediaVolume': prefs.playVolume,
        'servers': [
          for (final s in prefs.ownServers) {'id': s.id, 'name': s.name, 'reachable': null},
          for (final member in _members.values)
            for (final s in member.servers) {'id': '${member.device.id}.${s.id}', 'name': s.name, 'reachable': null, 'owner': member.device.name},
        ],
      },
      'performance': {
        'encoder': 'MediaCodec',
        'outputProfile': {'quality': prefs.videoQuality == 'copy' ? '720p' : prefs.videoQuality, 'fps': prefs.videoFps, 'bitrateKbps': prefs.videoBitrate},
      },
      'delivery': {
        'mode': delivery,
        'phase': broadcaster.starting ? 'preparing' : files.active ? 'ready' : '',
        'ready': files.active && !files.connecting,
        'error': files.error ?? '',
      },
      'group': {
        'admin': {'id': prefs.hostId, 'name': prefs.deviceName, 'kind': 'phone'},
        'controller': controller == null ? null : {'id': controller!.id, 'name': controller!.name, 'kind': controller!.kind},
        'members': [
          for (final device in prefs.hostDevices)
            {'id': device.id, 'name': device.name, 'kind': device.kind, 'online': isOnline(device.id), 'files': filesOf(device.id), 'servers': _members[device.id]?.servers.length ?? 0},
        ],
      },
    };
  }

  // ── HTTP ──

  Future<Map<String, dynamic>> _body(HttpRequest request) async {
    final text = await utf8.decoder.bind(request).join();
    if (text.trim().isEmpty) return {};
    final decoded = jsonDecode(text);
    return decoded is Map ? decoded.cast<String, dynamic>() : {};
  }

  Future<void> _json(HttpRequest request, int status, Object? body) async {
    final response = request.response;
    response.statusCode = status;
    response.headers.contentType = ContentType('application', 'json', charset: 'utf-8');
    response.add(utf8.encode(jsonEncode(body)));
    await response.close();
  }

  Future<void> _handle(HttpRequest request) async {
    try {
      final method = request.method;
      final path = request.uri.path;
      final member = _memberFor(request);

      if (method == 'GET' && path == '/api/lan-info') {
        final addresses = await lanAddresses();
        return await _json(request, 200, {
          'id': _prefs.hostId, 'kind': 'phone', 'name': _prefs.deviceName, 'version': 'phone', 'port': _server?.port, 'pinRequired': false, 'lanAccess': true,
          'addresses': [for (final a in addresses) 'http://$a:${_server?.port}'], 'playbackUrl': broadcaster.files.viewLink, 'rtspLanUrls': const <String>[],
        });
      }
      if (method == 'POST' && path == '/api/pair') {
        final body = await _body(request);
        if ('${body['code']}'.replaceAll(RegExp(r'\s'), '') != pairCode) return await _json(request, 403, {'error': 'Неверный код привязки.', 'code': 'pairing'});
        final token = _random(24);
        final device = HostDevice(
            id: _random(5).replaceAll(RegExp(r'[^A-Za-z0-9]'), 'x').substring(0, 6),
            name: '${body['name'] ?? ''}'.trim().isEmpty ? 'Устройство' : '${body['name']}'.trim().substring(0, min(40, '${body['name']}'.trim().length)),
            kind: body['kind'] == 'pc' ? 'pc' : 'phone',
            hash: _hash(token),
            at: DateTime.now());
        _prefs.update(() => _prefs.hostDevices = [..._prefs.hostDevices, device].take(20).toList());
        rotateCode();
        return await _json(request, 200, {'token': token, 'id': device.id});
      }
      if (method == 'GET' && path == '/api/pair/check') {
        return member == null ? await _json(request, 401, {'error': 'Нужна привязка.', 'code': 'pairing'}) : await _json(request, 200, {'ok': true, 'id': member.device.id});
      }
      if (method == 'GET' && (path == '/api/status' || path == '/api/events')) {
        if (path == '/api/status') return await _json(request, 200, state());
        final response = request.response;
        response.headers.contentType = ContentType('text', 'event-stream', charset: 'utf-8');
        response.headers.set('cache-control', 'no-cache');
        response.bufferOutput = false;
        final listener = _Listener(response, member?.device.id ?? '');
        _listeners.add(listener);
        if (member != null) {
          member.streams++;
          member.drop?.cancel();
          notifyListeners();
        }
        response.write('data: ${jsonEncode(state())}\n\n');
        response.done.catchError((_) {}).whenComplete(() {
          _listeners.remove(listener);
          if (member != null && --member.streams <= 0) {
            member.streams = 0;
            // Связь могла мигнуть: файлы и серверы убираем не сразу.
            member.drop = Timer(Duration(milliseconds: graceMs), () => _dropMember(member.device.id));
            _changed();
          }
        });
        return;
      }

      // Управление эфиром: как на ПК, доступно любому устройству в сети. Привязанное ещё и становится ведущим.
      if (method == 'POST' && path == '/api/playback') return await _json(request, 200, await _playback(await _body(request), member));
      if (method == 'POST' && path == '/api/start/queue') {
        final body = await _body(request);
        final error = await broadcaster.start(fromId: body['id'] == null ? null : '${body['id']}');
        if (error != null) return await _json(request, 400, {'error': error});
        _lead(member);
        return await _json(request, 200, state());
      }
      if (method == 'POST' && path == '/api/stop') {
        await broadcaster.stop();
        return await _json(request, 200, state());
      }
      if (method == 'POST' && path == '/api/queue') return await _addLink(request, await _body(request));
      if (method == 'POST' && path == '/api/queue/move') {
        final body = await _body(request);
        final from = _prefs.sharedFiles.indexWhere((f) => f.id == '${body['id']}');
        if (from >= 0) _prefs.moveSharedFile(from, (body['to'] as num?)?.toInt() ?? 0);
        return await _json(request, 200, state());
      }
      if (method == 'DELETE' && path.startsWith('/api/queue/')) {
        final id = Uri.decodeComponent(path.substring('/api/queue/'.length));
        if (_prefs.sharedFiles.any((f) => f.id == id)) {
          _prefs.removeSharedFile(id);
        } else {
          // Файл участника убираем из общей очереди; сам участник узнает об этом при следующей отправке.
          final dot = id.indexOf('.');
          final owner = dot < 0 ? null : _members[id.substring(0, dot)];
          if (owner != null) {
            owner.removed.add(id.substring(dot + 1));
            owner.files = owner.files.where((f) => f.id != id.substring(dot + 1)).toList();
            _syncQueue();
          }
        }
        _changed();
        return await _json(request, 200, state());
      }

      // Группа и настройки эфира: только привязанным устройствам.
      if (path.startsWith('/api/group/') || (method == 'POST' && path == '/api/config')) {
        if (member == null) return await _json(request, 401, {'error': 'Нужна привязка: введите код с этого устройства.', 'code': 'pairing'});
        if (path == '/api/group/take') {
          _lead(member);
          _changed();
          return await _json(request, 200, {'ok': true});
        }
        if (path == '/api/group/leave') {
          _dropMember(member.device.id);
          return await _json(request, 200, {'ok': true});
        }
        if (path == '/api/group/contribute') return await _contribute(request, member, await _body(request));
        if (path == '/api/config') return await _config(request, await _body(request));
      }
      await _json(request, 404, {'error': 'Нет такого маршрута.'});
    } catch (e) {
      try {
        await _json(request, 400, {'error': '$e'});
      } catch (_) {}
    }
  }

  Future<Map<String, Object?>> _playback(Map<String, dynamic> body, _Member? member) async {
    final files = broadcaster.files;
    switch ('${body['action']}') {
      case 'pause':
        files.pause();
      case 'resume':
        files.resume();
      case 'toggle':
        files.paused ? files.resume() : files.pause();
      case 'seek':
        files.seek((body['position'] as num?)?.toDouble() ?? 0);
      case 'next':
        files.next();
      case 'previous':
        files.previous();
      case 'jump':
        if (files.active) {
          files.jump('${body['id']}');
        } else {
          await broadcaster.start(fromId: '${body['id']}');
        }
        _lead(member);
      case 'loop':
        files.setLoop('${body['mode']}');
      case 'speed':
        broadcaster.setSpeed((body['speed'] as num?)?.toDouble() ?? 1);
      case 'volume':
        broadcaster.setVolume((body['volume'] as num?)?.toDouble() ?? 1);
    }
    return state();
  }

  Future<void> _addLink(HttpRequest request, Map<String, dynamic> body) async {
    final url = '${body['url'] ?? ''}'.trim();
    if (url.isEmpty) return await _json(request, 400, {'error': 'Нужна ссылка.'});
    try {
      final found = await (resolver ?? broadcaster.resolver).inspect(url);
      if (found.length > 20 && body['confirm'] != true) {
        return await _json(request, 200, {'ask': {'message': 'В плейлисте роликов: ${found.length}. Добавить все?'}});
      }
      _prefs.addSharedFiles([
        for (final info in found)
          SharedFile(id: SharedFile.newId(), path: '', title: info.title, url: info.url, duration: info.duration, thumbnail: info.thumbnail, kind: info.kind, sourceId: info.sourceId),
      ]);
      await _json(request, 200, {'added': found.length});
    } on UnsupportedLink catch (e) {
      await _json(request, 400, {'error': e.message});
    }
  }

  Future<void> _contribute(HttpRequest request, _Member member, Map<String, dynamic> body) async {
    final media = (body['media'] as Map?)?.cast<String, dynamic>();
    final base = Uri.tryParse('${media?['base'] ?? ''}');
    final key = '${media?['key'] ?? ''}';
    final peer = request.connectionInfo?.remoteAddress.address.replaceFirst('::ffff:', '');
    // Файлы забираются только с адреса самого участника: иначе его ключом можно было бы послать нас на чужой адрес.
    final trusted = base != null && base.scheme == 'http' && base.hasPort && (base.host == peer || (peer != null && _isLoopback(peer))) && RegExp(r'^[A-Za-z0-9_-]{16,64}$').hasMatch(key);
    member.base = trusted ? 'http://${base.host}:${base.port}' : '';
    member.key = trusted ? key : '';
    final seen = <String>{};
    member.files = [
      if (trusted)
        for (final raw in (body['queue'] as List? ?? const []))
          if (raw is Map && RegExp(r'^[\w.-]{1,64}$').hasMatch('${raw['id']}') && !member.removed.contains('${raw['id']}') && seen.add('${raw['id']}') && seen.length <= 200)
            SharedFile(id: '${raw['id']}', path: '', title: '${raw['title'] ?? raw['id']}'.trim(), duration: (raw['duration'] as num?)?.toDouble() ?? 0),
    ];
    member.servers = [
      for (final raw in (body['servers'] as List? ?? const []).take(10))
        if (raw is Map && '${raw['host']}'.isNotEmpty && '${raw['publishKey']}'.isNotEmpty)
          OwnServer(
              name: '${raw['name'] ?? raw['host']}',
              host: '${raw['host']}',
              rtspPort: (raw['rtspPort'] as num?)?.toInt() ?? 8554,
              key: '${raw['publishKey']}'),
    ];
    // Что админ убрал из их файлов: участник уберёт у себя тоже.
    final removed = member.removed.toList();
    _syncQueue();
    _changed();
    await _json(request, 200, {'ok': true, 'removed': removed});
  }

  static bool _isLoopback(String address) => address == '127.0.0.1' || address == '::1';

  Future<void> _config(HttpRequest request, Map<String, dynamic> body) async {
    final prefs = _prefs;
    prefs.update(() {
      final mode = body['outputMode'];
      if (mode == 'local') prefs.fileDelivery = 'lan';
      if (mode == 'tunnel') prefs.fileDelivery = 'tunnel';
      if (mode == 'remote') prefs.fileDelivery = 'server';
      if (const ['auto', 'cloudflare', 'serveo'].contains(body['tunnelProvider'])) prefs.tunnelProvider = '${body['tunnelProvider']}';
      final id = '${body['activeServerId'] ?? ''}';
      if (id.isNotEmpty && prefs.ownServers.any((s) => s.id == id)) prefs.ownServerId = id;
    });
    final quality = body['quality'] == null ? null : '${body['quality']}';
    final fps = (body['fps'] as num?)?.toInt();
    if (quality != null || fps != null) broadcaster.setProfile(quality: quality, fps: fps);
    await _json(request, 200, state());
  }
}
