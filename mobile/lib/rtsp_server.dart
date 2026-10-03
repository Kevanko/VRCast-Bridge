import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'mp4.dart';
import 'rtp.dart';
import 'sinks.dart';
import 'socket_writer.dart';

/// Мгновенная ссылка по локальной сети: телефон сам раздаёт эфир по RTSP (поверх TCP), как встроенный медиасервер на ПК.
/// VRChat и другие плееры в той же сети открывают `rtspt://адрес-телефона:порт/live`. Задержка около полусекунды.
class RtspServerSink implements Sink {
  RtspServerSink({this.path = 'live'});

  final String path;
  ServerSocket? _server;
  final _clients = <_Client>[];
  String _key = '';
  String _sdp = '';
  RtpStream? _video;
  RtpStream? _audio;
  bool _closed = false;
  int get port => _server?.port ?? 0;

  /// Сколько зрителей сейчас смотрит.
  int get viewers => _clients.where((c) => c.playing).length;

  Future<int> start({int port = 0}) async {
    final server = _server = await ServerSocket.bind(InternetAddress.anyIPv4, port, shared: true);
    server.listen(_accept, onError: (_) {});
    return server.port;
  }

  @override
  bool get closed => _closed;

  @override
  bool compatible(Mp4Info info) => true;

  @override
  void begin(Mp4Info info) {
    final key = info.configKey;
    if (key == _key) return;
    // Другие параметры кодеков: старое описание зрителю уже не подходит, ему нужно подключиться заново.
    final changed = _key.isNotEmpty;
    _key = key;
    _sdp = buildSdp(video: info.video, audio: info.audio, name: 'VRCast phone');
    _video = info.video == null ? null : RtpStream(96, 90000);
    _audio = info.audio == null ? null : RtpStream(97, info.audio!.sampleRate);
    if (changed) {
      for (final client in _clients.toList()) {
        client.close();
      }
    }
  }

  void _accept(Socket socket) {
    socket.setOption(SocketOption.tcpNoDelay, true);
    final client = _Client(socket, this);
    _clients.add(client);
  }

  void _gone(_Client client) => _clients.remove(client);

  @override
  void video(Mp4Track track, Uint8List data, {required double pts, required double dts, required bool sync}) {
    final rtp = _video;
    if (rtp == null || viewers == 0) {
      // Номера пакетов и метки времени всё равно ведём: зритель может подключиться в любой момент.
      if (rtp != null) _advance(rtp, pts);
      return;
    }
    final payloads = h264Payloads(track, data, sync: sync);
    final timestamp = rtp.timestampFor(pts);
    for (var i = 0; i < payloads.length; i++) {
      final packet = rtp.packet(payloads[i], timestamp, marker: i == payloads.length - 1);
      for (final client in _clients) {
        client.sendVideo(packet, sync && i == 0);
      }
    }
  }

  void _advance(RtpStream rtp, double pts) => rtp.lastTimestamp = rtp.timestampFor(pts);

  @override
  void audio(Mp4Track track, Uint8List data, {required double pts}) {
    final rtp = _audio;
    if (rtp == null || viewers == 0) return;
    final packet = rtp.packet(aacPayload(data), rtp.timestampFor(pts), marker: true);
    for (final client in _clients) {
      client.sendAudio(packet);
    }
  }

  @override
  void report(DateTime now) {
    for (final client in _clients) {
      if (!client.playing) continue;
      if (_video != null) client.sendVideoReport(_video!.senderReport(now));
      if (_audio != null) client.sendAudioReport(_audio!.senderReport(now));
    }
  }

  @override
  Future<void> flush() async {}

  @override
  Future<void> keepAlive() async {}

  @override
  Future<void> close() async {
    _closed = true;
    await _server?.close();
    for (final client in _clients.toList()) {
      client.close();
    }
  }
}

class _Client {
  _Client(this.socket, this.owner) {
    _writer = SocketWriter(socket, onFailure: close);
    socket.listen(_onData, onDone: close, onError: (_) => close(), cancelOnError: true);
  }

  final Socket socket;
  final RtspServerSink owner;
  late final SocketWriter _writer;
  final session = DateTime.now().microsecondsSinceEpoch.toRadixString(16);
  Uint8List _carry = Uint8List(0);
  bool playing = false;
  bool _gotKey = false;
  bool _closed = false;
  // Каналы interleaved, которые зритель назвал при SETUP: дорожка (по порядку описания) → (RTP, RTCP).
  final _channels = <int, (int, int)>{};
  int? get _videoChannel => owner._video == null ? null : _channels[0]?.$1;
  int? get _audioChannel => owner._audio == null ? null : _channels[owner._video == null ? 0 : 1]?.$1;

  void close() {
    if (_closed) return;
    _closed = true;
    playing = false;
    owner._gone(this);
    try {
      socket.destroy();
    } catch (_) {}
  }

  void _onData(Uint8List chunk) {
    final all = _carry.isEmpty ? chunk : (BytesBuilder()..add(_carry)..add(chunk)).toBytes();
    var p = 0;
    while (p < all.length) {
      if (all[p] == 0x24) {
        // Встречные RTCP-отчёты зрителя нам не нужны.
        if (p + 4 > all.length) break;
        final size = (all[p + 2] << 8) | all[p + 3];
        if (p + 4 + size > all.length) break;
        p += 4 + size;
        continue;
      }
      final end = _find(all, p);
      if (end < 0) break;
      final head = latin1.decode(all.sublist(p, end));
      final length = int.tryParse(RegExp(r'content-length:\s*(\d+)', caseSensitive: false).firstMatch(head)?.group(1) ?? '') ?? 0;
      if (end + 4 + length > all.length) break;
      p = end + 4 + length;
      _handle(head);
    }
    _carry = p >= all.length ? Uint8List(0) : Uint8List.sublistView(all, p);
    if (_carry.length > 65536) close();
  }

  static int _find(Uint8List bytes, int from) {
    for (var i = from; i + 3 < bytes.length; i++) {
      if (bytes[i] == 13 && bytes[i + 1] == 10 && bytes[i + 2] == 13 && bytes[i + 3] == 10) return i;
    }
    return -1;
  }

  void _reply(int status, String text, String cseq, {Map<String, String> headers = const {}, String body = ''}) {
    if (_closed) return;
    final lines = ['RTSP/1.0 $status $text', 'CSeq: $cseq', 'Server: VRCast'];
    headers.forEach((k, v) => lines.add('$k: $v'));
    final bytes = utf8.encode(body);
    if (bytes.isNotEmpty) lines.add('Content-Length: ${bytes.length}');
    _writer.add(latin1.encode('${lines.join('\r\n')}\r\n\r\n'));
    if (bytes.isNotEmpty) _writer.add(bytes);
  }

  void _handle(String head) {
    final lines = head.split('\r\n');
    final request = lines.first.split(' ');
    final method = request.first.toUpperCase();
    final uri = request.length > 1 ? request[1] : '';
    String? header(String name) {
      for (final line in lines.skip(1)) {
        final i = line.indexOf(':');
        if (i > 0 && line.substring(0, i).trim().toLowerCase() == name) return line.substring(i + 1).trim();
      }
      return null;
    }

    final cseq = header('cseq') ?? '0';
    final wanted = Uri.tryParse(uri)?.path ?? '';
    final onPath = wanted == '/${owner.path}' || wanted.startsWith('/${owner.path}/');
    switch (method) {
      case 'OPTIONS':
        _reply(200, 'OK', cseq, headers: {'Public': 'OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER'});
      case 'DESCRIBE':
        if (!onPath || owner._sdp.isEmpty) return _reply(404, 'Not Found', cseq);
        _reply(200, 'OK', cseq, headers: {'Content-Base': 'rtsp://${header('host') ?? 'localhost'}/${owner.path}/', 'Content-Type': 'application/sdp'}, body: owner._sdp);
      case 'SETUP':
        if (!onPath) return _reply(404, 'Not Found', cseq);
        final transport = header('transport') ?? '';
        final match = RegExp(r'interleaved=(\d+)-(\d+)').firstMatch(transport);
        // Только TCP: так не нужны открытые UDP-порты, и пакеты не теряются на Wi-Fi.
        if (match == null || !transport.contains('/TCP')) return _reply(461, 'Unsupported Transport', cseq);
        final track = int.tryParse(RegExp(r'streamid=(\d+)').firstMatch(uri)?.group(1) ?? '') ?? _channels.length;
        _channels[track] = (int.parse(match.group(1)!), int.parse(match.group(2)!));
        _reply(200, 'OK', cseq, headers: {'Transport': 'RTP/AVP/TCP;unicast;interleaved=${match.group(1)}-${match.group(2)}', 'Session': '$session;timeout=60'});
      case 'PLAY':
        if (!onPath) return _reply(404, 'Not Found', cseq);
        if (_channels.isEmpty) return _reply(455, 'Method Not Valid in This State', cseq);
        _reply(200, 'OK', cseq, headers: {'Session': session, 'Range': 'npt=0.000-'});
        playing = true;
        // Новый зритель начинает с ближайшего ключевого кадра: без него картинка не соберётся.
        _gotKey = owner._video == null;
      case 'PAUSE':
        _reply(200, 'OK', cseq, headers: {'Session': session});
      case 'GET_PARAMETER':
        _reply(200, 'OK', cseq, headers: {'Session': session});
      case 'TEARDOWN':
        _reply(200, 'OK', cseq, headers: {'Session': session});
        close();
      default:
        _reply(501, 'Not Implemented', cseq);
    }
  }

  void _write(int channel, Uint8List packet) {
    if (_closed) return;
    final frame = Uint8List(4 + packet.length);
    frame[0] = 0x24;
    frame[1] = channel;
    frame[2] = packet.length >> 8;
    frame[3] = packet.length & 0xFF;
    frame.setRange(4, frame.length, packet);
    _writer.add(frame);
  }

  /// Зритель на медленном канале не должен копить память: при большом отставании ждём следующий ключевой кадр.
  bool get _overloaded => _writer.backlog > 3 * 1024 * 1024;

  void sendVideo(Uint8List packet, bool keyStart) {
    final channel = _videoChannel;
    if (!playing || channel == null) return;
    if (keyStart) _gotKey = true;
    if (_overloaded) {
      _gotKey = false;
      return;
    }
    if (_gotKey) _write(channel, packet);
  }

  void sendAudio(Uint8List packet) {
    final channel = _audioChannel;
    if (!playing || channel == null || _overloaded) return;
    // Звук идёт сразу; картинка присоединится с ключевого кадра.
    _write(channel, packet);
  }

  void sendVideoReport(Uint8List report) {
    final channel = owner._video == null ? null : _channels[0]?.$2;
    if (playing && channel != null) _write(channel, report);
  }

  void sendAudioReport(Uint8List report) {
    final channel = owner._audio == null ? null : _channels[owner._video == null ? 0 : 1]?.$2;
    if (playing && channel != null) _write(channel, report);
  }
}
