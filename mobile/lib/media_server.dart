import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

/// Файл, который телефон отдаёт в общую очередь. Лежит на телефоне, ПК играет его по сети,
/// пока телефон подключён.
class SharedFile {
  SharedFile({required this.id, required this.path, required this.title});

  final String id; // короткий, из букв и цифр: он идёт в адрес
  final String path;
  final String title;

  Map<String, Object?> toJson() => {'id': id, 'path': path, 'title': title};

  factory SharedFile.fromJson(Map<String, dynamic> json) => SharedFile(id: '${json['id']}', path: '${json['path']}', title: '${json['title']}');

  static String newId() {
    const letters = 'abcdefghijklmnopqrstuvwxyz0123456789';
    final random = Random.secure();
    return List.generate(10, (_) => letters[random.nextInt(letters.length)]).join();
  }
}

/// Маленький HTTP-сервер на телефоне: отдаёт общие файлы по `/api/media/<id>?k=<ключ>` с поддержкой Range
/// (перемотка у ПК). Без ключа и без такого файла не отвечает.
class MediaServer {
  MediaServer({required this.files, String? key}) : key = key ?? _newKey();

  final List<SharedFile> Function() files;
  final String key;
  HttpServer? _server;

  static String _newKey() {
    final random = Random.secure();
    return base64Url.encode(List.generate(18, (_) => random.nextInt(256))).replaceAll('=', '');
  }

  int? get port => _server?.port;

  Future<int> start({int port = 0}) async {
    if (_server != null) return _server!.port;
    final server = _server = await HttpServer.bind(InternetAddress.anyIPv4, port, shared: true);
    server.listen(_handle, onError: (_) {});
    return server.port;
  }

  Future<void> stop() async {
    final server = _server;
    _server = null;
    await server?.close(force: true);
  }

  static const _types = {
    'mp4': 'video/mp4', 'm4v': 'video/mp4', 'mov': 'video/quicktime', 'mkv': 'video/x-matroska', 'webm': 'video/webm', 'avi': 'video/x-msvideo',
    'ts': 'video/mp2t', 'mp3': 'audio/mpeg', 'm4a': 'audio/mp4', 'aac': 'audio/aac', 'flac': 'audio/flac', 'wav': 'audio/wav', 'ogg': 'audio/ogg', 'opus': 'audio/ogg',
  };

  Future<void> _handle(HttpRequest request) async {
    final response = request.response;
    try {
      final segments = request.uri.pathSegments;
      final id = segments.length == 3 && segments[0] == 'api' && segments[1] == 'media' ? segments[2] : null;
      final given = request.uri.queryParameters['k'] ?? '';
      // Ключ сравниваем целиком: слишком короткий или чужой — сразу отказ.
      SharedFile? file;
      for (final candidate in files()) {
        if (candidate.id == id) file = candidate;
      }
      final allowed = file != null && given.length == key.length && _sameSecret(given, key) && (request.method == 'GET' || request.method == 'HEAD');
      final disk = allowed ? File(file.path) : null;
      if (disk == null || !await disk.exists()) {
        response.statusCode = allowed ? HttpStatus.notFound : HttpStatus.forbidden;
        return;
      }
      final size = await disk.length();
      final extension = file!.path.split('.').last.toLowerCase();
      response.headers
        ..set(HttpHeaders.contentTypeHeader, _types[extension] ?? 'application/octet-stream')
        ..set(HttpHeaders.acceptRangesHeader, 'bytes');
      var start = 0, end = size - 1;
      final range = RegExp(r'^bytes=(\d*)-(\d*)$').firstMatch(request.headers.value(HttpHeaders.rangeHeader) ?? '');
      if (range != null && (range.group(1)!.isNotEmpty || range.group(2)!.isNotEmpty)) {
        if (range.group(1)!.isEmpty) {
          start = max(0, size - int.parse(range.group(2)!)); // последние N байт
        } else {
          start = int.parse(range.group(1)!);
          if (range.group(2)!.isNotEmpty) end = min(end, int.parse(range.group(2)!));
        }
        if (start > end || start >= size) {
          response.statusCode = HttpStatus.requestedRangeNotSatisfiable;
          response.headers.set(HttpHeaders.contentRangeHeader, 'bytes */$size');
          return;
        }
        response.statusCode = HttpStatus.partialContent;
        response.headers.set(HttpHeaders.contentRangeHeader, 'bytes $start-$end/$size');
      }
      response.contentLength = end - start + 1;
      if (request.method == 'HEAD') return;
      await response.addStream(disk.openRead(start, end + 1));
    } catch (_) {
      // Клиент (ffmpeg на ПК) закрыл соединение при перемотке — это обычное дело.
    } finally {
      try {
        await response.close();
      } catch (_) {}
    }
  }

  static bool _sameSecret(String a, String b) {
    var diff = a.length ^ b.length;
    for (var i = 0; i < a.length && i < b.length; i++) {
      diff |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
    }
    return diff == 0;
  }
}

/// Адрес телефона в той же сети, что и ПК: ПК заберёт файлы именно по нему.
Future<String?> localAddressFor(String peerHost) async {
  final interfaces = await NetworkInterface.list(type: InternetAddressType.IPv4);
  final addresses = [for (final nic in interfaces) for (final a in nic.addresses) if (!a.isLoopback) a.address];
  final prefix = peerHost.split('.').take(3).join('.');
  for (final address in addresses) {
    if (address.startsWith('$prefix.')) return address;
  }
  for (final address in addresses) {
    if (address.startsWith('192.168.') || address.startsWith('10.') || RegExp(r'^172\.(1[6-9]|2\d|3[01])\.').hasMatch(address)) return address;
  }
  return addresses.isEmpty ? null : addresses.first;
}
