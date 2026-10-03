import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import 'socket_writer.dart';

class RtspException implements Exception {
  RtspException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Публикация потока на RTSP-сервер (MediaMTX на VPS): ANNOUNCE → SETUP → RECORD, пакеты идут по тому же TCP-соединению.
/// Это то, что делает ffmpeg с `-f rtsp -rtsp_transport tcp`, только без ffmpeg.
abstract class RtspOut {
  bool get closed;
  void sendRtp(int track, Uint8List packet);
  void sendRtcp(int track, Uint8List packet);
  Future<void> flush();
  Future<void> keepAlive();
  Future<void> close();
}

class RtspSession implements RtspOut {
  RtspSession._(this._socket, this.url, this._user, this._pass) {
    _writer = SocketWriter(_socket, onFailure: _finish);
  }

  final Socket _socket;
  late final SocketWriter _writer;
  final Uri url;
  final String _user, _pass;
  int _cseq = 0;
  String? _session;
  Map<String, String>? _digest; // realm, nonce — после первого 401
  bool _basic = false;
  final _pending = <int, Completer<_Response>>{};
  Uint8List _carry = Uint8List(0);
  bool _closed = false;
  final _done = Completer<void>();

  @override
  bool get closed => _closed;

  /// Открыть сеанс и начать запись. Дорожки получают каналы 0-1, 2-3 (RTP и RTCP).
  static Future<RtspSession> publish(Uri url, {required String user, required String pass, required String sdp, required int tracks, Duration timeout = const Duration(seconds: 8)}) async {
    final socket = await Socket.connect(url.host, url.port, timeout: timeout);
    socket.setOption(SocketOption.tcpNoDelay, true);
    final session = RtspSession._(socket, url, user, pass).._listen();
    try {
      final base = url.replace(userInfo: '').toString();
      await session._request('OPTIONS', base);
      await session._request('ANNOUNCE', base, headers: {'Content-Type': 'application/sdp'}, body: sdp);
      for (var i = 0; i < tracks; i++) {
        final reply = await session._request('SETUP', '$base/streamid=$i', headers: {'Transport': 'RTP/AVP/TCP;unicast;interleaved=${i * 2}-${i * 2 + 1};mode=record'});
        session._session ??= reply.headers['session']?.split(';').first;
      }
      await session._request('RECORD', base, headers: {'Range': 'npt=0.000-'});
      return session;
    } catch (_) {
      await session.close();
      rethrow;
    }
  }

  void _listen() {
    _socket.listen(_onData, onError: (_) => _finish(), onDone: _finish, cancelOnError: true);
  }

  void _finish() {
    if (_closed) return;
    _closed = true;
    for (final waiting in _pending.values) {
      if (!waiting.isCompleted) {
        waiting.future.ignore(); // ждущий мог уже уйти по таймауту: ошибку никто не ждёт, и она не должна всплыть наверх
        waiting.completeError(RtspException('Сервер закрыл соединение'));
      }
    }
    _pending.clear();
    if (!_done.isCompleted) _done.complete();
  }

  // Ответы сервера и встречные interleaved-кадры (RTCP от сервера нам не нужны).
  void _onData(Uint8List chunk) {
    final all = _carry.isEmpty ? chunk : (BytesBuilder()..add(_carry)..add(chunk)).toBytes();
    var p = 0;
    while (p < all.length) {
      if (all[p] == 0x24) {
        if (p + 4 > all.length) break;
        final size = (all[p + 2] << 8) | all[p + 3];
        if (p + 4 + size > all.length) break;
        p += 4 + size;
        continue;
      }
      final end = _indexOf(all, const [13, 10, 13, 10], p);
      if (end < 0) break;
      final head = latin1.decode(all.sublist(p, end));
      final lines = head.split('\r\n');
      final status = int.tryParse(lines.first.split(' ').elementAtOrNull(1) ?? '') ?? 0;
      final headers = <String, String>{};
      for (final line in lines.skip(1)) {
        final i = line.indexOf(':');
        if (i > 0) headers.putIfAbsent(line.substring(0, i).trim().toLowerCase(), () => line.substring(i + 1).trim());
      }
      final wwwAuthenticate = [for (final line in lines.skip(1)) if (line.toLowerCase().startsWith('www-authenticate:')) line.substring(17).trim()];
      final length = int.tryParse(headers['content-length'] ?? '') ?? 0;
      if (end + 4 + length > all.length) break;
      p = end + 4 + length;
      final cseq = int.tryParse(headers['cseq'] ?? '');
      final waiting = cseq == null ? null : _pending.remove(cseq);
      waiting?.complete(_Response(status, headers, wwwAuthenticate));
    }
    _carry = p >= all.length ? Uint8List(0) : Uint8List.sublistView(all, p);
  }

  static int _indexOf(Uint8List bytes, List<int> pattern, int from) {
    for (var i = from; i + pattern.length <= bytes.length; i++) {
      var ok = true;
      for (var k = 0; k < pattern.length; k++) {
        if (bytes[i + k] != pattern[k]) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
    return -1;
  }

  String? _authorization(String method, String uri) {
    final digest = _digest;
    if (digest != null) {
      String md5hex(String s) => md5.convert(utf8.encode(s)).toString();
      final ha1 = md5hex('$_user:${digest['realm']}:$_pass');
      final ha2 = md5hex('$method:$uri');
      final response = md5hex('$ha1:${digest['nonce']}:$ha2');
      return 'Digest username="$_user", realm="${digest['realm']}", nonce="${digest['nonce']}", uri="$uri", response="$response"';
    }
    if (_basic) return 'Basic ${base64.encode(utf8.encode('$_user:$_pass'))}';
    return null;
  }

  Future<_Response> _request(String method, String uri, {Map<String, String> headers = const {}, String? body, bool retry = true}) async {
    if (_closed) throw RtspException('Соединение с сервером потеряно');
    final cseq = ++_cseq;
    final lines = ['$method $uri RTSP/1.0', 'CSeq: $cseq', 'User-Agent: VRCast', if (_session != null) 'Session: $_session'];
    final auth = _authorization(method, uri);
    if (auth != null) lines.add('Authorization: $auth');
    headers.forEach((k, v) => lines.add('$k: $v'));
    final bytes = body == null ? null : utf8.encode(body);
    if (bytes != null) lines.add('Content-Length: ${bytes.length}');
    final waiting = _pending[cseq] = Completer<_Response>();
    _writer.add(latin1.encode('${lines.join('\r\n')}\r\n\r\n'));
    if (bytes != null) _writer.add(bytes);
    final reply = await waiting.future.timeout(const Duration(seconds: 8), onTimeout: () => throw RtspException('Сервер не отвечает'));
    if (reply.status == 401 && retry) {
      final challenge = reply.authenticate;
      final digestLine = challenge.firstWhere((l) => l.toLowerCase().startsWith('digest'), orElse: () => '');
      if (digestLine.isNotEmpty) {
        final fields = <String, String>{};
        for (final m in RegExp(r'(\w+)="([^"]*)"').allMatches(digestLine)) {
          fields[m.group(1)!] = m.group(2)!;
        }
        if (fields['nonce'] == null) throw RtspException('Сервер прислал непонятный запрос ключа');
        _digest = fields;
      } else if (challenge.any((l) => l.toLowerCase().startsWith('basic'))) {
        _basic = true;
      } else {
        throw RtspException('Сервер не принимает такой способ входа');
      }
      return _request(method, uri, headers: headers, body: body, retry: false);
    }
    if (reply.status == 401 || reply.status == 403) throw RtspException('Сервер не принял ключ. Проверьте ключ сервера в настройках');
    if (reply.status == 404) throw RtspException('Сервер не нашёл путь публикации');
    if (reply.status >= 400) throw RtspException('Сервер отказал (${reply.status})');
    return reply;
  }

  @override
  void sendRtp(int track, Uint8List packet) => _interleaved(track * 2, packet);

  @override
  void sendRtcp(int track, Uint8List packet) => _interleaved(track * 2 + 1, packet);

  void _interleaved(int channel, Uint8List packet) {
    if (_closed) return;
    final frame = Uint8List(4 + packet.length);
    frame[0] = 0x24;
    frame[1] = channel;
    frame[2] = packet.length >> 8;
    frame[3] = packet.length & 0xFF;
    frame.setRange(4, frame.length, packet);
    _writer.add(frame);
  }

  @override
  Future<void> flush() async {
    if (_closed) return;
    await _writer.flush();
  }

  /// Пока эфир на паузе, сервер должен слышать нас: иначе через 10 с он закроет публикацию.
  @override
  Future<void> keepAlive() async {
    if (_closed) return;
    try {
      await _request('OPTIONS', url.replace(userInfo: '').toString(), retry: false);
    } catch (_) {}
  }

  @override
  Future<void> close() async {
    if (!_closed) {
      try {
        _writer.add(latin1.encode('TEARDOWN ${url.replace(userInfo: '')} RTSP/1.0\r\nCSeq: ${++_cseq}\r\n${_session != null ? 'Session: $_session\r\n' : ''}\r\n'));
        await _writer.flush().timeout(const Duration(seconds: 1));
      } catch (_) {}
    }
    _closed = true;
    _socket.destroy();
    if (!_done.isCompleted) _done.complete();
  }
}

class _Response {
  _Response(this.status, this.headers, this.authenticate);
  final int status;
  final Map<String, String> headers;
  final List<String> authenticate;
}
