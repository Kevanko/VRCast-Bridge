import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

/// Готовая запись HLS (VOD) как один непрерывный файл. MediaExtractor плейлисты m3u8 не читает, поэтому сегменты
/// склеиваются «на лету» и отдаются движку по локальному HTTP с поддержкой Range (перемотка работает).
class HlsPlaylist {
  HlsPlaylist({required this.segments, required this.duration, this.init, this.fragmented = false});
  final List<Uri> segments;
  final double duration;
  final Uri? init; // начальный сегмент fMP4 (#EXT-X-MAP)
  final bool fragmented;
}

class HlsUnsupported implements Exception {
  HlsUnsupported(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Разобрать плейлист: главный → лучший вариант не выше [maxHeight], затем сегменты. Прямые эфиры и шифрование не поддерживаются.
Future<HlsPlaylist> loadHls(Uri url, {int maxHeight = 720, HttpClient? client}) async {
  final http = client ?? (HttpClient()..connectionTimeout = const Duration(seconds: 8));
  try {
    var uri = url;
    var text = await _text(http, uri);
    if (text.contains('#EXT-X-STREAM-INF')) {
      uri = _pickVariant(text, uri, maxHeight);
      text = await _text(http, uri);
    }
    return parseMedia(text, uri);
  } finally {
    if (client == null) http.close(force: true);
  }
}

Uri _pickVariant(String text, Uri base, int maxHeight) {
  final lines = const LineSplitter().convert(text);
  Uri? best, smallest;
  var bestHeight = -1, smallestHeight = 1 << 30;
  for (var i = 0; i < lines.length - 1; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    var j = i + 1;
    while (j < lines.length && (lines[j].isEmpty || lines[j].startsWith('#'))) {
      j++;
    }
    if (j >= lines.length) break;
    final height = int.tryParse(RegExp(r'RESOLUTION=\d+x(\d+)').firstMatch(lines[i])?.group(1) ?? '') ?? 0;
    final uri = base.resolve(lines[j].trim());
    if (height <= maxHeight && height > bestHeight) {
      best = uri;
      bestHeight = height;
    }
    if (height < smallestHeight) {
      smallest = uri;
      smallestHeight = height;
    }
  }
  final picked = best ?? smallest;
  if (picked == null) throw HlsUnsupported('В плейлисте нет потоков');
  return picked;
}

HlsPlaylist parseMedia(String text, Uri base) {
  if (!text.contains('#EXT-X-ENDLIST')) throw HlsUnsupported('Прямые трансляции без ПК не поддерживаются');
  final segments = <Uri>[];
  Uri? init;
  var duration = 0.0;
  var fragmented = false;
  for (final raw in const LineSplitter().convert(text)) {
    final line = raw.trim();
    if (line.isEmpty) continue;
    if (line.startsWith('#EXT-X-KEY')) {
      if (!line.contains('METHOD=NONE')) throw HlsUnsupported('Защищённый поток (шифрование) без ПК не поддерживается');
    } else if (line.startsWith('#EXT-X-BYTERANGE')) {
      throw HlsUnsupported('Плейлист с BYTERANGE без ПК не поддерживается');
    } else if (line.startsWith('#EXT-X-MAP')) {
      final value = RegExp(r'URI="([^"]+)"').firstMatch(line)?.group(1);
      if (value != null) {
        init = base.resolve(value);
        fragmented = true;
      }
    } else if (line.startsWith('#EXTINF:')) {
      duration += double.tryParse(line.substring(8).split(',').first) ?? 0;
    } else if (!line.startsWith('#')) {
      segments.add(base.resolve(line));
    }
  }
  if (segments.isEmpty) throw HlsUnsupported('В плейлисте нет сегментов');
  return HlsPlaylist(segments: segments, duration: duration, init: init, fragmented: fragmented);
}

Future<String> _text(HttpClient http, Uri uri) async {
  final response = await (await http.getUrl(uri)).close();
  if (response.statusCode != 200) {
    await response.drain<void>();
    throw HlsUnsupported('Сервер ответил ${response.statusCode}');
  }
  return utf8.decode(await response.fold<List<int>>([], (all, chunk) => all..addAll(chunk)), allowMalformed: true);
}

/// Локальный сервер, отдающий склеенные сегменты как один файл.
class HlsConcatServer {
  HlsConcatServer._(this._server, this._playlist, this._http);

  final HttpServer _server;
  final HlsPlaylist _playlist;
  final HttpClient _http;
  late final List<Uri> _parts = [if (_playlist.init != null) _playlist.init!, ..._playlist.segments];
  List<int> _offsets = const []; // начало каждой части; последний элемент — общая длина
  Uri? _cachedUri;
  Uint8List? _cached;

  static Future<HlsConcatServer> start(HlsPlaylist playlist, {HttpClient? client}) async {
    final http = client ?? (HttpClient()..connectionTimeout = const Duration(seconds: 8));
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final self = HlsConcatServer._(server, playlist, http);
    server.listen(self._handle, onError: (_) {});
    return self;
  }

  /// Адрес для движка. Длины сегментов узнаются при первом обращении.
  Uri get url => Uri.parse('http://127.0.0.1:${_server.port}/stream.${_playlist.fragmented ? 'mp4' : 'ts'}');

  Future<void> _measure() async {
    if (_offsets.isNotEmpty) return;
    final sizes = List<int>.filled(_parts.length, 0);
    var next = 0;
    Future<void> worker() async {
      while (next < _parts.length) {
        final i = next++;
        sizes[i] = await _size(_parts[i]);
      }
    }

    await Future.wait([for (var k = 0; k < 8; k++) worker()]);
    var sum = 0;
    _offsets = [for (final size in sizes) (sum += size) - size, sum];
  }

  Future<int> _size(Uri uri) async {
    final head = await (await _http.openUrl('HEAD', uri)).close();
    await head.drain<void>();
    final length = head.contentLength;
    if (head.statusCode == 200 && length >= 0) return length;
    // Сервер не отвечает на HEAD: скачиваем сегмент, он останется в кэше.
    return (await _fetch(uri)).length;
  }

  Future<Uint8List> _fetch(Uri uri) async {
    if (_cachedUri == uri && _cached != null) return _cached!;
    final response = await (await _http.getUrl(uri)).close();
    if (response.statusCode != 200) {
      await response.drain<void>();
      throw HttpException('сегмент ответил ${response.statusCode}', uri: uri);
    }
    final builder = BytesBuilder(copy: false);
    await for (final chunk in response) {
      builder.add(chunk);
    }
    _cachedUri = uri;
    return _cached = builder.takeBytes();
  }

  Future<void> _handle(HttpRequest request) async {
    try {
      await _measure();
      final total = _offsets.last;
      var start = 0, end = total - 1;
      final range = RegExp(r'bytes=(\d*)-(\d*)').firstMatch(request.headers.value('range') ?? '');
      if (range != null) {
        if (range.group(1)!.isNotEmpty) {
          start = int.parse(range.group(1)!);
          if (range.group(2)!.isNotEmpty) end = int.parse(range.group(2)!).clamp(start, total - 1);
        } else if (range.group(2)!.isNotEmpty) {
          start = (total - int.parse(range.group(2)!)).clamp(0, total - 1);
        }
      }
      final response = request.response;
      if (start >= total) {
        response.statusCode = HttpStatus.requestedRangeNotSatisfiable;
        response.headers.set('content-range', 'bytes */$total');
        await response.close();
        return;
      }
      response.statusCode = range == null ? HttpStatus.ok : HttpStatus.partialContent;
      response.headers.set('accept-ranges', 'bytes');
      response.headers.contentType = ContentType('video', _playlist.fragmented ? 'mp4' : 'mp2t');
      response.contentLength = end - start + 1;
      if (range != null) response.headers.set('content-range', 'bytes $start-$end/$total');
      if (request.method == 'HEAD') {
        await response.close();
        return;
      }
      var part = _partAt(start);
      var position = start;
      while (position <= end && part < _parts.length) {
        final data = await _fetch(_parts[part]);
        final from = position - _offsets[part];
        final to = (end + 1 - _offsets[part]).clamp(0, data.length);
        if (to > from) response.add(Uint8List.sublistView(data, from, to));
        position = _offsets[part] + data.length;
        part++;
      }
      await response.close();
    } catch (_) {
      try {
        await request.response.close();
      } catch (_) {}
    }
  }

  int _partAt(int offset) {
    var low = 0, high = _parts.length - 1;
    while (low < high) {
      final mid = (low + high + 1) >> 1;
      if (_offsets[mid] <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low;
  }

  Future<void> close() async {
    await _server.close(force: true);
    _http.close(force: true);
  }
}
