import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';

/// Ключ шифрования сегмента (AES-128, режим CBC).
class HlsKey {
  HlsKey(this.uri, this.iv);
  final Uri uri;
  final Uint8List? iv; // не задан — берётся номер сегмента
}

class HlsSegment {
  HlsSegment(this.uri, this.seq, this.key);
  final Uri uri;
  final int seq;
  final HlsKey? key;
}

/// Плейлист HLS: запись (VOD) или прямой эфир. MediaExtractor плейлисты m3u8 не читает, поэтому сегменты склеиваются
/// «на лету» и отдаются движку по локальному HTTP (запись — с Range, перемотка работает; эфир — потоком).
class HlsPlaylist {
  HlsPlaylist({required this.mediaUri, required this.segments, required this.duration, this.init, this.live = false, this.targetSeconds = 6});
  final Uri mediaUri;
  final List<HlsSegment> segments;
  final double duration;
  final HlsSegment? init; // начальный сегмент fMP4 (#EXT-X-MAP)
  final bool live;
  final double targetSeconds;
  bool get fragmented => init != null;
}

class HlsUnsupported implements Exception {
  HlsUnsupported(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Разобрать плейлист: главный → лучший вариант не выше [maxHeight], затем сегменты.
Future<HlsPlaylist> loadHls(Uri url, {int maxHeight = 720, HttpClient? client, Map<String, String> headers = const {}}) async {
  final http = client ?? (HttpClient()..connectionTimeout = const Duration(seconds: 8));
  try {
    var uri = url;
    var text = await _text(http, uri, headers);
    if (text.contains('#EXT-X-STREAM-INF')) {
      uri = _pickVariant(text, uri, maxHeight);
      text = await _text(http, uri, headers);
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
  final live = !text.contains('#EXT-X-ENDLIST');
  final segments = <HlsSegment>[];
  HlsSegment? init;
  HlsKey? key;
  var duration = 0.0, target = 6.0, sequence = 0;
  for (final raw in const LineSplitter().convert(text)) {
    final line = raw.trim();
    if (line.isEmpty) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      sequence = int.tryParse(line.substring(22)) ?? 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      target = double.tryParse(line.substring(22)) ?? 6;
    } else if (line.startsWith('#EXT-X-KEY')) {
      final method = RegExp(r'METHOD=([A-Z0-9-]+)').firstMatch(line)?.group(1) ?? 'NONE';
      if (method == 'NONE') {
        key = null;
      } else if (method == 'AES-128') {
        final uri = RegExp(r'URI="([^"]+)"').firstMatch(line)?.group(1);
        if (uri == null) throw HlsUnsupported('У ключа шифрования нет адреса');
        key = HlsKey(base.resolve(uri), _parseIv(RegExp(r'IV=0[xX]([0-9a-fA-F]+)').firstMatch(line)?.group(1)));
      } else {
        throw HlsUnsupported('Защита потока ($method) без ПК не поддерживается');
      }
    } else if (line.startsWith('#EXT-X-BYTERANGE')) {
      throw HlsUnsupported('Плейлист с BYTERANGE без ПК не поддерживается');
    } else if (line.startsWith('#EXT-X-MAP')) {
      final value = RegExp(r'URI="([^"]+)"').firstMatch(line)?.group(1);
      if (value != null) init = HlsSegment(base.resolve(value), -1, null);
    } else if (line.startsWith('#EXTINF:')) {
      duration += double.tryParse(line.substring(8).split(',').first) ?? 0;
    } else if (!line.startsWith('#')) {
      segments.add(HlsSegment(base.resolve(line), sequence + segments.length, key));
    }
  }
  if (segments.isEmpty) throw HlsUnsupported('В плейлисте нет сегментов');
  return HlsPlaylist(mediaUri: base, segments: segments, duration: live ? 0 : duration, init: init, live: live, targetSeconds: target);
}

Uint8List? _parseIv(String? hex) {
  if (hex == null) return null;
  final padded = hex.padLeft(32, '0');
  return Uint8List.fromList([for (var i = 0; i < 32; i += 2) int.parse(padded.substring(i, i + 2), radix: 16)]);
}

Uint8List _sequenceIv(int seq) {
  final iv = Uint8List(16);
  for (var i = 0; i < 4; i++) {
    iv[15 - i] = (seq >> (8 * i)) & 255;
  }
  return iv;
}

/// Расшифровать сегмент AES-128-CBC (в конце — набивка PKCS7).
Uint8List decryptSegment(Uint8List data, Uint8List key, Uint8List iv) {
  if (data.isEmpty || data.length % 16 != 0) return data;
  final cipher = CBCBlockCipher(AESEngine())..init(false, ParametersWithIV(KeyParameter(key), iv));
  final out = Uint8List(data.length);
  for (var offset = 0; offset < data.length; offset += 16) {
    cipher.processBlock(data, offset, out, offset);
  }
  final pad = out.last;
  return pad >= 1 && pad <= 16 && pad <= out.length ? Uint8List.sublistView(out, 0, out.length - pad) : out;
}

Future<String> _text(HttpClient http, Uri uri, Map<String, String> headers) async {
  final request = await http.getUrl(uri);
  headers.forEach(request.headers.set);
  final response = await request.close();
  if (response.statusCode != 200) {
    await response.drain<void>();
    throw HlsUnsupported('Сервер ответил ${response.statusCode}');
  }
  return utf8.decode(await response.fold<List<int>>([], (all, chunk) => all..addAll(chunk)), allowMalformed: true);
}

/// Локальный сервер, отдающий сегменты HLS как один файл (запись) или непрерывный поток (эфир).
class HlsConcatServer {
  HlsConcatServer._(this._server, this._playlist, this._http, this._headers);

  final HttpServer _server;
  final HlsPlaylist _playlist;
  final HttpClient _http;
  final Map<String, String> _headers;
  final _keys = <Uri, Uint8List>{};
  late final List<HlsSegment> _parts = [if (_playlist.init != null) _playlist.init!, ..._playlist.segments];
  List<int> _offsets = const []; // начало каждой части; последний элемент — общая длина
  Uri? _cachedUri;
  Uint8List? _cached;
  bool _closed = false;

  static Future<HlsConcatServer> start(HlsPlaylist playlist, {HttpClient? client, Map<String, String> headers = const {}}) async {
    final http = client ?? (HttpClient()..connectionTimeout = const Duration(seconds: 8));
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final self = HlsConcatServer._(server, playlist, http, headers);
    server.listen(self._handle, onError: (_) {});
    return self;
  }

  Uri get url => Uri.parse('http://127.0.0.1:${_server.port}/stream.${_playlist.fragmented ? 'mp4' : 'ts'}');

  // ── Сегменты ──

  Future<Uint8List> _download(Uri uri, {String? range}) async {
    final request = await _http.getUrl(uri);
    _headers.forEach(request.headers.set);
    if (range != null) request.headers.set('range', range);
    final response = await request.close();
    if (response.statusCode != 200 && response.statusCode != 206) {
      await response.drain<void>();
      throw HttpException('сервер ответил ${response.statusCode}', uri: uri);
    }
    final builder = BytesBuilder(copy: false);
    await for (final chunk in response) {
      builder.add(chunk);
    }
    return builder.takeBytes();
  }

  Future<Uint8List> _keyBytes(Uri uri) async => _keys[uri] ??= await _download(uri);

  Future<Uint8List> _fetch(HlsSegment segment) async {
    if (_cachedUri == segment.uri && _cached != null) return _cached!;
    var data = await _download(segment.uri);
    final key = segment.key;
    if (key != null) data = decryptSegment(data, await _keyBytes(key.uri), key.iv ?? _sequenceIv(segment.seq));
    _cachedUri = segment.uri;
    return _cached = data;
  }

  // ── Запись: один файл с Range ──

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

  Future<int> _size(HlsSegment segment) async {
    try {
      final head = await (await _http.openUrl('HEAD', segment.uri)).close();
      await head.drain<void>();
      final length = head.contentLength;
      if (head.statusCode == 200 && length >= 0) {
        final key = segment.key;
        if (key == null || length < 32) return key == null ? length : (await _fetch(segment)).length;
        // Шифрованный сегмент короче на длину набивки: её видно, расшифровав последний блок (нужны два последних блока).
        final tail = await _download(segment.uri, range: 'bytes=${length - 32}-${length - 1}');
        if (tail.length == 32) {
          final last = decryptSegment(tail, await _keyBytes(key.uri), Uint8List.sublistView(tail, 0, 16)).length;
          // decryptSegment расшифровал два блока подряд с первым как «IV»: второй блок расшифровался верно, первый — нет.
          return length - (32 - last);
        }
      }
    } catch (_) {}
    return (await _fetch(segment)).length;
  }

  Future<void> _handle(HttpRequest request) async {
    try {
      if (_playlist.live) return await _handleLive(request);
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

  // ── Эфир: сегменты по мере появления ──

  Future<void> _handleLive(HttpRequest request) async {
    final response = request.response;
    response.statusCode = HttpStatus.ok;
    response.headers.contentType = ContentType('video', _playlist.fragmented ? 'mp4' : 'mp2t');
    response.bufferOutput = false;
    if (request.method == 'HEAD') {
      await response.close();
      return;
    }
    var playlist = _playlist;
    var last = -1;
    var disconnected = false;
    unawaited(response.done.then((_) => disconnected = true, onError: (_) => disconnected = true));
    if (playlist.init != null) response.add(await _fetch(playlist.init!));
    var first = true;
    var empty = 0;
    while (!_closed && !disconnected) {
      // Первый раз начинаем с последних сегментов: ближе к «сейчас».
      final fresh = playlist.segments.where((s) => s.seq > last).toList();
      final take = first && fresh.length > 3 ? fresh.sublist(fresh.length - 3) : fresh;
      first = false;
      for (final segment in take) {
        if (_closed || disconnected) break;
        response.add(await _fetch(segment));
        last = segment.seq;
      }
      if (fresh.isNotEmpty) last = fresh.last.seq;
      if (!playlist.live) break;
      empty = fresh.isEmpty ? empty + 1 : 0;
      if (empty > 12) break; // эфир замолчал надолго: заканчиваем, движок решит, что делать
      await Future<void>.delayed(Duration(milliseconds: (playlist.targetSeconds * 400).round().clamp(500, 4000)));
      try {
        playlist = parseMedia(await _text(_http, _playlist.mediaUri, _headers), _playlist.mediaUri);
      } catch (_) {
        empty++;
      }
    }
    await response.close();
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
    _closed = true;
    await _server.close(force: true);
    _http.close(force: true);
  }
}
