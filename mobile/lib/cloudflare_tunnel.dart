import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'public_tunnel.dart';

/// Бесплатная ссылка Cloudflare прямо с телефона: запускает `cloudflared` (быстрый туннель без аккаунта) и отдаёт адрес
/// вида https://что-то.trycloudflare.com, который ведёт на HTTP-сервер телефона.
///
/// В Android у программ нет /etc/resolv.conf, и cloudflared (Go) не может найти адрес api.trycloudflare.com. Поэтому запрос
/// ссылки идёт не напрямую, а через маленький переходник на телефоне (флаг --quick-service): он пересылает его в настоящий
/// API средствами системы. Адреса узлов Cloudflare подставляются сразу (флаг --edge), поиск по DNS им не нужен.
class CloudflareTunnel extends PublicTunnel {
  CloudflareTunnel._(this._process, this._gateway, this.url, this._lines);

  final Process _process;
  final QuickServiceGateway _gateway;
  @override
  final String url;
  @override
  String get provider => 'Cloudflare';
  final List<String> _lines;
  final _closed = Completer<void>();

  @override
  Future<void> get closed => _closed.future;

  static final _address = RegExp(r'https://[a-z0-9-]+\.trycloudflare\.com', caseSensitive: false);

  /// Журнал cloudflared (последние строки) — для сообщения об ошибке.
  String get log => _lines.join('\n');

  /// Запустить туннель на локальный порт. Бросает исключение с понятным текстом, если за [timeout] ссылка не поднялась.
  static Future<CloudflareTunnel> start({
    required String binary,
    required int localPort,
    Duration timeout = const Duration(seconds: 60),
    String? bindAddress,
    Future<List<String>> Function()? edgeAddresses,
  }) async {
    if (!File(binary).existsSync()) throw CloudflareException('В этой сборке нет Cloudflare. Используйте свой сервер.');
    final gateway = await QuickServiceGateway.start();
    final edges = await (edgeAddresses ?? _lookupEdges)();
    final args = [
      'tunnel', '--no-autoupdate', '--protocol', 'http2', '--quick-service', 'http://127.0.0.1:${gateway.port}',
      if (bindAddress != null) ...['--edge-bind-address', bindAddress],
      for (final edge in edges) ...['--edge', edge],
      '--url', 'http://127.0.0.1:$localPort',
    ];
    late final Process process;
    try {
      process = await Process.start(binary, args);
    } catch (e) {
      await gateway.stop();
      throw CloudflareException('Не удалось запустить Cloudflare: $e');
    }
    final lines = <String>[];
    final url = Completer<String>();
    final registered = Completer<void>();
    registered.future.ignore(); // если упадёт раньше, чем дойдём до ожидания, ошибку уже несёт url
    Future<void> read(Stream<List<int>> stream) {
      final done = Completer<void>();
      stream.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
        lines.add(line);
        if (lines.length > 40) lines.removeAt(0);
        final found = _address.firstMatch(line);
        if (found != null && !url.isCompleted) url.complete(found.group(0)!.toLowerCase());
        if (line.contains('Registered tunnel connection') && !registered.isCompleted) registered.complete();
      }, onError: (_) {}, onDone: done.complete);
      return done.future;
    }

    final outputs = [read(process.stdout), read(process.stderr)];
    // Причину берём из вывода целиком: код выхода приходит раньше, чем дочитаны последние строки.
    final exited = Future.wait(outputs).then((_) async {
      final code = await process.exitCode;
      if (!registered.isCompleted) debugPrint('cloudflared завершился ($code):\n${lines.join('\n')}');
      final error = CloudflareException(_explain(lines, code));
      if (!url.isCompleted) url.completeError(error);
      if (!registered.isCompleted) registered.completeError(error);
    });
    unawaited(exited);
    try {
      final address = await url.future.timeout(timeout);
      await registered.future.timeout(timeout);
      final tunnel = CloudflareTunnel._(process, gateway, address, lines);
      unawaited(exited.then((_) {
        if (!tunnel._closed.isCompleted) tunnel._closed.complete();
      }));
      return tunnel;
    } on TimeoutException {
      process.kill();
      await gateway.stop();
      throw CloudflareException('Cloudflare не ответил за ${timeout.inSeconds} с. Проверьте интернет или VPN.');
    } catch (_) {
      process.kill();
      await gateway.stop();
      rethrow;
    }
  }

  static String _explain(List<String> lines, int code) {
    final text = lines.join('\n').toLowerCase();
    if (text.contains('failed to request quick tunnel')) return 'Cloudflare не выдал ссылку. Проверьте интернет.';
    if (text.contains('tls handshake') || text.contains('unable to establish connection')) return 'Не удалось подключиться к Cloudflare (возможно, мешает VPN).';
    return 'Cloudflare остановился (код $code).';
  }

  static Future<List<String>> _lookupEdges() async {
    final out = <String>[];
    for (final host in const ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com']) {
      try {
        final found = await InternetAddress.lookup(host, type: InternetAddressType.IPv4).timeout(const Duration(seconds: 5));
        out.addAll(found.take(2).map((a) => '${a.address}:7844'));
      } catch (_) {}
    }
    return out;
  }

  @override
  Future<void> stop() async {
    if (stopped) return;
    markStopped();
    _process.kill();
    await _gateway.stop();
    if (!_closed.isCompleted) _closed.complete();
  }
}

/// Путь к cloudflared, который лежит в приложении (libcloudflared.so в папке нативных библиотек), или null, если его нет в сборке.
Future<String?> bundledCloudflared() async {
  try {
    final dir = await const MethodChannel('vrcast/screen').invokeMethod<String>('nativeLibraryDir');
    final path = '$dir/libcloudflared.so';
    return dir != null && File(path).existsSync() ? path : null;
  } catch (_) {
    return null;
  }
}

class CloudflareException implements Exception {
  CloudflareException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Переходник для запроса ссылки: cloudflared шлёт POST /tunnel сюда (по обычному http на loopback), а мы пересылаем его в
/// настоящий API по https. Имя сервера разрешает система телефона, у которой DNS в порядке.
class QuickServiceGateway {
  QuickServiceGateway._(this._server, this.upstream);
  final HttpServer _server;
  final Uri upstream;

  int get port => _server.port;

  static Future<QuickServiceGateway> start({Uri? upstream}) async {
    final gateway = QuickServiceGateway._(await HttpServer.bind(InternetAddress.loopbackIPv4, 0), upstream ?? Uri.parse('https://api.trycloudflare.com'));
    gateway._server.listen(gateway._handle, onError: (_) {});
    return gateway;
  }

  Future<void> stop() => _server.close(force: true);

  Future<void> _handle(HttpRequest request) async {
    final response = request.response;
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 15);
    try {
      // Нужен только запрос новой ссылки; всё остальное cloudflared у этой службы не просит.
      if (request.method != 'POST' || request.uri.path != '/tunnel') {
        response.statusCode = HttpStatus.notFound;
        return;
      }
      final body = await request.fold<List<int>>(<int>[], (all, chunk) => all..addAll(chunk));
      final forward = await client.postUrl(upstream.resolve('/tunnel'));
      final type = request.headers.value(HttpHeaders.contentTypeHeader);
      if (type != null) forward.headers.set(HttpHeaders.contentTypeHeader, type);
      forward.headers.set(HttpHeaders.userAgentHeader, request.headers.value(HttpHeaders.userAgentHeader) ?? 'cloudflared');
      forward.add(body);
      final answer = await forward.close().timeout(const Duration(seconds: 20));
      response.statusCode = answer.statusCode;
      final answerType = answer.headers.value(HttpHeaders.contentTypeHeader);
      if (answerType != null) response.headers.set(HttpHeaders.contentTypeHeader, answerType);
      await response.addStream(answer);
    } catch (_) {
      response.statusCode = HttpStatus.badGateway;
    } finally {
      client.close(force: true);
      try {
        await response.close();
      } catch (_) {}
    }
  }
}
