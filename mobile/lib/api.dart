import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

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
  ApiException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Клиент к серверу VRCast Bridge на ПК.
class Api {
  Api(this.base, {http.Client? client}) : _client = client ?? http.Client();

  final Uri base; // например http://192.168.1.5:4717
  final http.Client _client;

  Uri uri(String path) => base.resolve(path);

  /// Адрес для картинок и потока (путь с сервера → полный URL).
  String absolute(String path) => path.startsWith('http') ? path : uri(path).toString();

  Future<Map<String, dynamic>> _send(String method, String path, [Object? body]) async {
    final request = http.Request(method, uri(path));
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    final response = await http.Response.fromStream(await _client.send(request).timeout(const Duration(seconds: 8)));
    final decoded = response.body.isEmpty ? <String, dynamic>{} : jsonDecode(response.body);
    final map = decoded is Map ? decoded.cast<String, dynamic>() : <String, dynamic>{};
    if (response.statusCode >= 400) throw ApiException('${map['error'] ?? 'Ошибка ${response.statusCode}'}');
    return map;
  }

  Future<BridgeState> status() async => BridgeState.fromJson(await _send('GET', '/api/status?logs=0'));

  Future<Map<String, dynamic>> lanInfo() => _send('GET', '/api/lan-info');

  /// Поток состояний; при обрыве выбрасывает ошибку — переподключается вызывающий.
  Stream<BridgeState> events() async* {
    final request = http.Request('GET', uri('/api/events'))..headers['Accept'] = 'text/event-stream';
    final response = await _client.send(request).timeout(const Duration(seconds: 8));
    if (response.statusCode != 200) throw ApiException('Сервер ответил ${response.statusCode}');
    await for (final text in parseSse(response.stream)) {
      yield BridgeState.fromJson((jsonDecode(text) as Map).cast<String, dynamic>());
    }
  }

  Future<void> playback(String action, [Map<String, Object?> extra = const {}]) => _send('POST', '/api/playback', {'action': action, ...extra});
  Future<void> startQueue([String? id]) => _send('POST', '/api/start/queue', id == null ? {} : {'id': id});
  Future<void> stop() => _send('POST', '/api/stop', {});
  Future<void> removeFromQueue(String id) => _send('DELETE', '/api/queue/${Uri.encodeComponent(id)}');
  Future<void> moveInQueue(String id, int to) => _send('POST', '/api/queue/move', {'id': id, 'to': to});

  /// Добавить ссылку. Сервер может переспросить (большой плейлист) — тогда вернётся ask.
  Future<Map<String, dynamic>> addLink(String url, {bool confirm = false}) => _send('POST', '/api/queue', {'url': url, if (confirm) 'confirm': true});

  void close() => _client.close();
}
