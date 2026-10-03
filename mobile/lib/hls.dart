import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'mp4.dart';
import 'rtp.dart';
import 'sinks.dart';

const _pmtPid = 0x1000, _videoPid = 0x100, _audioPid = 0x101;
const _startOffset = 1.4; // метки времени не должны начинаться с нуля: PCR идёт раньше кадров

int _ts90(double seconds) => ((seconds + _startOffset) * 90000).round() & 0x1FFFFFFFF;

/// Упаковка в MPEG-TS: H.264 из mp4 переводится в Annex B, AAC получает заголовки ADTS. Перекодирования нет.
class TsWriter {
  final _cc = <int, int>{};

  Uint8List tables({required bool video, required bool audio}) {
    final out = BytesBuilder();
    // PAT: программа 1 → PMT.
    out.add(_psi(0, [0x00, 0x01, 0xC1, 0x00, 0x00, 0x00, 0x01, 0xE0 | (_pmtPid >> 8), _pmtPid & 0xFF]));
    final streams = <int>[];
    if (video) streams.addAll([0x1B, 0xE0 | (_videoPid >> 8), _videoPid & 0xFF, 0xF0, 0x00]);
    if (audio) streams.addAll([0x0F, 0xE0 | (_audioPid >> 8), _audioPid & 0xFF, 0xF0, 0x00]);
    final pcrPid = video ? _videoPid : _audioPid;
    out.add(_psi(_pmtPid, [0x00, 0x01, 0xC1, 0x00, 0x00, 0xE0 | (pcrPid >> 8), pcrPid & 0xFF, 0xF0, 0x00, ...streams]));
    return out.toBytes();
  }

  // Одна таблица в одном пакете: указатель, заголовок секции, тело, CRC32.
  Uint8List _psi(int pid, List<int> body) {
    final id = pid == 0 ? 0x00 : 0x02;
    final section = <int>[id, 0xB0 | ((body.length + 4) >> 8), (body.length + 4) & 0xFF, ...body];
    final crc = _crc32(section);
    section.addAll([crc >> 24, (crc >> 16) & 0xFF, (crc >> 8) & 0xFF, crc & 0xFF]);
    // Таблица занимает пакет целиком: остаток добивается 0xFF, а не полем адаптации.
    final payload = Uint8List(184)..fillRange(0, 184, 0xFF);
    payload.setRange(0, 1 + section.length, [0, ...section]);
    return _packets(pid, payload);
  }

  static int _crc32(List<int> bytes) {
    var crc = 0xFFFFFFFF;
    for (final b in bytes) {
      crc ^= b << 24;
      for (var i = 0; i < 8; i++) {
        crc = (crc & 0x80000000) != 0 ? ((crc << 1) ^ 0x04C11DB7) : (crc << 1);
        crc &= 0xFFFFFFFF;
      }
    }
    return crc;
  }

  /// Кадр видео (NAL с start-кодами) → пакеты TS. PCR ставится на ключевых кадрах.
  Uint8List video(Mp4Track track, Uint8List sample, {required double pts, required double dts, required bool sync}) {
    final es = BytesBuilder();
    es.add(const [0, 0, 0, 1, 0x09, 0xF0]); // разделитель кадров
    for (final nal in h264Nals(track, sample, sync: sync)) {
      es.add(const [0, 0, 0, 1]);
      es.add(nal);
    }
    final pesBytes = _pes(0xE0, es.toBytes(), pts: _ts90(pts), dts: pts == dts ? null : _ts90(dts), unbounded: true);
    return _packets(_videoPid, pesBytes, pcr: sync ? (_ts90(dts) - 63000).clamp(0, 0x1FFFFFFFF) : null, randomAccess: sync);
  }

  Uint8List audio(Mp4Track track, Uint8List frame, {required double pts, bool withPcr = false}) {
    final asc = track.asc!;
    final aot = asc[0] >> 3;
    final freq = ((asc[0] & 7) << 1) | (asc[1] >> 7);
    final channels = (asc[1] >> 3) & 15;
    final length = frame.length + 7;
    final adts = Uint8List(7 + frame.length);
    adts[0] = 0xFF;
    adts[1] = 0xF1;
    adts[2] = (((aot - 1) & 3) << 6) | (freq << 2) | ((channels >> 2) & 1);
    adts[3] = ((channels & 3) << 6) | ((length >> 11) & 3);
    adts[4] = (length >> 3) & 0xFF;
    adts[5] = ((length & 7) << 5) | 0x1F;
    adts[6] = 0xFC;
    adts.setRange(7, adts.length, frame);
    return _packets(_audioPid, _pes(0xC0, adts, pts: _ts90(pts), unbounded: false), pcr: withPcr ? (_ts90(pts) - 63000).clamp(0, 0x1FFFFFFFF) : null, randomAccess: withPcr);
  }

  Uint8List _pes(int streamId, Uint8List data, {required int pts, int? dts, required bool unbounded}) {
    final header = <int>[];
    void stamp(int prefix, int value) {
      header.addAll([
        (prefix << 4) | (((value >> 30) & 7) << 1) | 1,
        (value >> 22) & 0xFF,
        (((value >> 15) & 0x7F) << 1) | 1,
        (value >> 7) & 0xFF,
        ((value & 0x7F) << 1) | 1,
      ]);
    }

    if (dts != null) {
      stamp(3, pts);
      stamp(1, dts);
    } else {
      stamp(2, pts);
    }
    final optional = [0x80, dts != null ? 0xC0 : 0x80, header.length, ...header];
    final length = unbounded ? 0 : optional.length + data.length;
    final out = BytesBuilder();
    out.add([0, 0, 1, streamId, length >> 8, length & 0xFF, ...optional]);
    out.add(data);
    return out.toBytes();
  }

  Uint8List _packets(int pid, Uint8List payload, {int? pcr, bool randomAccess = false}) {
    final out = BytesBuilder();
    var at = 0;
    var first = true;
    while (at < payload.length || first) {
      final withPcr = first && pcr != null;
      final capacity = withPcr ? 176 : 184;
      final take = payload.length - at < capacity ? payload.length - at : capacity;
      final packet = Uint8List(188);
      final cc = _cc[pid] ?? 0;
      _cc[pid] = (cc + 1) & 15;
      packet[0] = 0x47;
      packet[1] = (first ? 0x40 : 0) | (pid >> 8);
      packet[2] = pid & 0xFF;
      final adaptation = 184 - take; // с байтом длины; 0 — поля нет совсем
      packet[3] = ((adaptation > 0 ? 3 : 1) << 4) | cc;
      var p = 4;
      if (adaptation > 0) {
        packet[p++] = adaptation - 1;
        if (adaptation > 1) {
          packet[p++] = (first && randomAccess ? 0x40 : 0) | (withPcr ? 0x10 : 0);
          if (withPcr) {
            final base = pcr;
            packet[p++] = (base >> 25) & 0xFF;
            packet[p++] = (base >> 17) & 0xFF;
            packet[p++] = (base >> 9) & 0xFF;
            packet[p++] = (base >> 1) & 0xFF;
            packet[p++] = ((base & 1) << 7) | 0x7E;
            packet[p++] = 0;
          }
          while (p < 4 + adaptation) {
            packet[p++] = 0xFF;
          }
        }
      }
      packet.setRange(p, 188, payload, at);
      out.add(packet);
      at += take;
      first = false;
    }
    return out.toBytes();
  }
}

class HlsSegment {
  HlsSegment(this.sequence, this.duration, this.bytes, this.discontinuity);
  final int sequence;
  final double duration;
  final Uint8List bytes;
  final bool discontinuity;
}

/// Эфир в HLS: кадры режутся на сегменты по ключевым кадрам, плейлист живой, в памяти держатся последние сегменты.
class HlsSink implements Sink {
  HlsSink({this.segmentSeconds = 2, this.keep = 6});

  final double segmentSeconds;
  final int keep;
  final _ts = TsWriter();
  final segments = <HlsSegment>[];
  int _nextSequence = 0;
  BytesBuilder? _current;
  double _currentStart = 0;
  double _lastTime = 0;
  bool _pendingDiscontinuity = false;
  bool _currentDiscontinuity = false;
  bool _hasVideo = false;
  bool _hasAudio = false;
  bool _closed = false;
  bool _pcrPending = false;

  @override
  bool get closed => _closed;

  /// Есть ли что отдавать зрителям.
  bool get ready => segments.isNotEmpty;

  @override
  bool compatible(Mp4Info info) => true;

  @override
  void begin(Mp4Info info) {
    _cut();
    _hasVideo = info.video != null;
    _hasAudio = info.audio != null;
    _pendingDiscontinuity = _nextSequence > 0;
  }

  void _start(double time) {
    _current = BytesBuilder()..add(_ts.tables(video: _hasVideo, audio: _hasAudio));
    _currentStart = time;
    _currentDiscontinuity = _pendingDiscontinuity;
    _pendingDiscontinuity = false;
    _pcrPending = true;
  }

  void _cut() {
    final current = _current;
    _current = null;
    if (current == null) return;
    final duration = _lastTime - _currentStart;
    if (duration <= 0) return;
    segments.add(HlsSegment(_nextSequence++, duration, current.toBytes(), _currentDiscontinuity));
    while (segments.length > keep) {
      segments.removeAt(0);
    }
  }

  @override
  void video(Mp4Track track, Uint8List data, {required double pts, required double dts, required bool sync}) {
    if (_current == null) {
      if (!sync) return; // начинаем только с ключевого кадра
      _start(dts);
    } else if (sync && dts - _currentStart >= segmentSeconds) {
      _lastTime = dts;
      _cut();
      _start(dts);
    }
    _lastTime = dts;
    _current!.add(_ts.video(track, data, pts: pts, dts: dts, sync: sync));
  }

  @override
  void audio(Mp4Track track, Uint8List data, {required double pts}) {
    if (_current == null) {
      if (_hasVideo) return; // звук ждёт первого ключевого кадра
      _start(pts);
    } else if (!_hasVideo && pts - _currentStart >= segmentSeconds) {
      _lastTime = pts;
      _cut();
      _start(pts);
    }
    if (!_hasVideo) _lastTime = pts;
    // Без видео часы потока (PCR) ведёт звук: ставим их в начале каждого сегмента.
    _current!.add(_ts.audio(track, data, pts: pts, withPcr: !_hasVideo && _pcrPending));
    _pcrPending = false;
  }

  @override
  void report(DateTime now) {}

  @override
  Future<void> flush() async {}

  @override
  Future<void> keepAlive() async {}

  @override
  Future<void> close() async {
    _closed = true;
  }

  String playlist() {
    final target = segments.isEmpty ? 2 : segments.map((s) => s.duration).reduce((a, b) => a > b ? a : b).ceil();
    final out = StringBuffer('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:$target\n#EXT-X-MEDIA-SEQUENCE:${segments.isEmpty ? 0 : segments.first.sequence}\n');
    for (final segment in segments) {
      if (segment.discontinuity) out.write('#EXT-X-DISCONTINUITY\n');
      out.write('#EXTINF:${segment.duration.toStringAsFixed(3)},\nseg-${segment.sequence}.ts\n');
    }
    return out.toString();
  }

  Uint8List? segment(int sequence) {
    for (final segment in segments) {
      if (segment.sequence == sequence) return segment.bytes;
    }
    return null;
  }
}

/// Маленький HTTP-сервер для HLS на самом телефоне. Через него смотрят и по бесплатной ссылке (туннель Cloudflare ведёт сюда).
class HlsServer {
  HlsServer(this.sink);

  final HlsSink sink;
  HttpServer? _server;

  int? get port => _server?.port;

  Future<int> start({int port = 0, InternetAddress? address}) async {
    final server = _server = await HttpServer.bind(address ?? InternetAddress.loopbackIPv4, port);
    server.listen(_handle, onError: (_) {});
    return server.port;
  }

  Future<void> stop() async {
    final server = _server;
    _server = null;
    await server?.close(force: true);
  }

  Future<void> _handle(HttpRequest request) async {
    final response = request.response;
    try {
      response.headers.set('Access-Control-Allow-Origin', '*');
      final path = request.uri.path;
      if (request.method != 'GET' && request.method != 'HEAD') {
        response.statusCode = HttpStatus.methodNotAllowed;
      } else if (path == '/stream/live.m3u8' || path == '/stream/preview.m3u8') {
        if (!sink.ready) {
          response.statusCode = HttpStatus.notFound;
        } else {
          final body = sink.playlist();
          response.headers
            ..set(HttpHeaders.contentTypeHeader, 'application/vnd.apple.mpegurl')
            ..set(HttpHeaders.cacheControlHeader, 'no-cache');
          response.contentLength = body.length;
          if (request.method == 'GET') response.write(body);
        }
      } else {
        final match = RegExp(r'^/stream/seg-(\d+)\.ts$').firstMatch(path);
        final bytes = match == null ? null : sink.segment(int.parse(match.group(1)!));
        if (bytes == null) {
          response.statusCode = HttpStatus.notFound;
        } else {
          response.headers.set(HttpHeaders.contentTypeHeader, 'video/mp2t');
          response.contentLength = bytes.length;
          if (request.method == 'GET') response.add(bytes);
        }
      }
    } catch (_) {
    } finally {
      try {
        await response.close();
      } catch (_) {}
    }
  }
}
