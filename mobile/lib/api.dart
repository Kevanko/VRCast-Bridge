import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'models.dart';
import 'own_server.dart';

/// Разбор потока Server-Sent Events: отдаёт тело каждого события (строки data:).
Stream<String> parseSse(Stream<List<int>> bytes) async* {
  final data = <String>[];
  await for (final line in bytes.map<List<int>>((chunk) => chunk).transform(utf8.decoder).transform(const LineSplitter())) {
    if (line.isEmpty) {
      if (data.isNotEmpty) yield data.join('\n');
      data.clear();
    } else if (line.startsWith('data:')) {
      data.add(line.substring(5).trimLeft());
    }
  }
}

class ApiException implements Exception {
  ApiException(this.message, {this.code = ''});
  final String message;
  final String code; // 'pin' — ПК просит PIN, 'pairing' — нужна привязка
  @override
  String toString() => message;
}

/// Клиент к серверу VRCast Bridge на ПК.
class Api {
  Api(this.base, {http.Client? client, this.token}) : _client = client ?? http.Client();

  final Uri base; // например http://192.168.1.5:4717
  String? token; // ключ привязки: нужен для настроек эфира
  final http.Client _client;

  Uri uri(String path) => base.resolve(path);

  /// Адрес для картинок и потока (путь с сервера → полный URL).
  String absolute(String path) => path.startsWith('http') ? path : uri(path).toString();

  Future<Map<String, dynamic>> _send(String method, String path, [Object? body]) async {
    final request = http.Request(method, uri(path));
    if (token != null) request.headers['X-VRCast-Token'] = token!;
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    final response = await http.Response.fromStream(await _client.send(request).timeout(const Duration(seconds: 8)));
    final decoded = response.body.isEmpty ? <String, dynamic>{} : jsonDecode(response.body);
    final map = decoded is Map ? decoded.cast<String, dynamic>() : <String, dynamic>{};
    if (response.statusCode >= 400) throw ApiException('${map['error'] ?? 'Ошибка ${response.statusCode}'}', code: '${map['code'] ?? ''}');
    return map;
  }

  Future<BridgeState> status() async => BridgeState.fromJson(await _send('GET', '/api/status?logs=0'));

  Future<Map<String, dynamic>> lanInfo() => _send('GET', '/api/lan-info');

  /// Поток состояний; при обрыве выбрасывает ошибку — переподключается вызывающий.
  Stream<BridgeState> events() async* {
    final request = http.Request('GET', uri('/api/events'))..headers['Accept'] = 'text/event-stream';
    if (token != null) request.headers['X-VRCast-Token'] = token!;
    final response = await _client.send(request).timeout(const Duration(seconds: 8));
    if (response.statusCode != 200) {
      var code = '';
      try {
        code = '${(jsonDecode(await response.stream.bytesToString()) as Map)['code'] ?? ''}';
      } catch (_) {}
      throw ApiException(code == 'pin' ? 'Этот ПК просит PIN' : 'Сервер ответил ${response.statusCode}', code: code);
    }
    await for (final text in parseSse(response.stream)) {
      yield BridgeState.fromJson((jsonDecode(text) as Map).cast<String, dynamic>());
    }
  }

  Future<void> playback(String action, [Map<String, Object?> extra = const {}]) => _send('POST', '/api/playback', {'action': action, ...extra});
  Future<void> startQueue([String? id]) => _send('POST', '/api/start/queue', id == null ? {} : {'id': id});
  Future<void> stop() => _send('POST', '/api/stop', {});

  /// Привязка к ПК по коду из его настроек; возвращает ключ.
  Future<String> pair(String code, String name) async => '${(await _send('POST', '/api/pair', {'code': code, 'name': name, 'kind': 'phone'}))['token']}';

  /// Номер этого устройства в группе на ПК (по ключу привязки).
  Future<String> myId() async => '${(await _send('GET', '/api/pair/check'))['id'] ?? ''}';

  Future<bool> pairCheck() async {
    try {
      await _send('GET', '/api/pair/check');
      return true;
    } on ApiException {
      return false;
    }
  }

  /// Отдаём группе свои файлы и серверы, пока подключены. ПК отвечает, какие файлы другие убрали из общей очереди.
  Future<List<String>> contribute({required String mediaBase, required String mediaKey, required List<Map<String, Object?>> files, required List<OwnServer> servers}) async {
    final reply = await _send('POST', '/api/group/contribute', {
      'media': {'base': mediaBase, 'key': mediaKey},
      'queue': files,
      'servers': [for (final s in servers) {'id': s.id, 'name': s.name, 'host': s.host, 'rtspPort': s.rtspPort, 'publishKey': s.key}],
    });
    return [for (final id in (reply['removed'] as List? ?? const [])) '$id'];
  }

  /// Забрать эфир себе: дальше его ведёт это устройство.
  Future<void> take() => _send('POST', '/api/group/take', {});

  /// Настройки эфира на ПК (outputMode, tunnelProvider, activeServerId, quality, fps, encoderMode, whiteIp).
  Future<void> setStream(Map<String, Object?> values) => _send('POST', '/api/config', values);

  /// Эфир с экрана телефона: поток доходит до ПК не сразу, поэтому пробуем несколько раз.
  Future<void> startPhone() async {
    for (var attempt = 0;; attempt++) {
      try {
        await _send('POST', '/api/start/phone', {});
        return;
      } on ApiException {
        if (attempt >= 7) rethrow;
        await Future<void>.delayed(const Duration(seconds: 1));
      }
    }
  }
  Future<void> removeFromQueue(String id) => _send('DELETE', '/api/queue/${Uri.encodeComponent(id)}');
  Future<void> moveInQueue(String id, int to) => _send('POST', '/api/queue/move', {'id': id, 'to': to});

  /// Добавить ссылку. Сервер может переспросить (большой плейлист) — тогда вернётся ask.
  Future<Map<String, dynamic>> addLink(String url, {bool confirm = false}) => _send('POST', '/api/queue', {'url': url, if (confirm) 'confirm': true});

  /// Отправить файл с телефона в очередь ПК. Тело идёт потоком, память не растёт на больших файлах.
  Future<void> uploadFile(String path, String name, void Function(double) onProgress) async {
    final file = File(path);
    final length = await file.length();
    final request = http.StreamedRequest('POST', uri('/api/queue/upload?name=${Uri.encodeQueryComponent(name)}'))
      ..contentLength = length
      ..headers['Content-Type'] = 'application/octet-stream';
    final response = _client.send(request);
    var sent = 0;
    await request.sink.addStream(file.openRead().map((chunk) {
      sent += chunk.length;
      onProgress(length == 0 ? 1 : sent / length);
      return chunk;
    }));
    await request.sink.close();
    final done = await http.Response.fromStream(await response);
    if (done.statusCode >= 400) {
      final decoded = done.body.isEmpty ? null : jsonDecode(done.body);
      throw ApiException('${decoded is Map ? decoded['error'] : null ?? 'Ошибка ${done.statusCode}'}');
    }
  }

  void close() => _client.close();
}
