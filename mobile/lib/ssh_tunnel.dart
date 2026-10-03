import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dartssh2/dartssh2.dart';
import 'package:pinenacl/ed25519.dart';

import 'public_tunnel.dart';
import 'ssh.dart';

/// Одноразовый ключ для сервисов, которые просят хоть какой-нибудь SSH-ключ (Serveo). Создаётся один раз и хранится в приложении.
String generateTunnelKey() {
  final key = SigningKey.generate();
  final pair = OpenSSHEd25519KeyPair(Uint8List.fromList(key.verifyKey.asTypedList), Uint8List.fromList(key.asTypedList), 'vrcast');
  return pair.toPem();
}

final _ansi = RegExp(r'\x1B\[[0-9;]*[A-Za-z]');

/// Адрес туннеля из текста, который сервис печатает после подключения (цвета и служебные знаки убираются).
String? tunnelUrlFromBanner(String text, RegExp pattern) => pattern.firstMatch(text.replaceAll(_ansi, ''))?.group(0)?.toLowerCase();

/// Бесплатная ссылка Serveo: телефон по SSH просит сервис пробросить порт 80 к себе и получает адрес вида
/// https://….serveousercontent.com. Ни программы, ни аккаунта не нужно, только интернет.
class SshTunnel extends PublicTunnel {
  SshTunnel._(this._client, this.url, this.provider);

  final SSHClient _client;
  @override
  final String url;
  @override
  final String provider;

  static final serveoUrl = RegExp(r'https://[a-z0-9.-]+\.serveousercontent\.com', caseSensitive: false);

  @override
  Future<void> get closed => _client.done;

  /// [readUrl]: false — адрес не ждём из текста сервиса, а строим из выданного порта (для проверок на своём sshd).
  static Future<SshTunnel> start({
    required int localPort,
    required String privateKey,
    String host = 'serveo.net',
    int port = 22,
    String user = 'serveo',
    int remotePort = 80,
    String name = 'Serveo',
    bool readUrl = true,
    RegExp? urlPattern,
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final client = await openSsh(host: host, port: port, user: user, privateKey: privateKey, answerPrompts: true, timeout: timeout);
    try {
      final forward = await client.forwardRemote(port: remotePort).timeout(timeout);
      if (forward == null) throw SshError('$name не дал пробросить порт.');
      forward.connections.listen((channel) => unawaited(_pipe(channel, localPort)), onError: (_) {});
      var address = 'http://127.0.0.1:${forward.port}';
      if (readUrl) {
        final session = await client.shell().timeout(timeout);
        final text = StringBuffer();
        final found = Completer<String>();
        void read(Stream<List<int>> stream) => stream.transform(utf8.decoder).listen((chunk) {
              text.write(chunk);
              final url = tunnelUrlFromBanner(text.toString(), urlPattern ?? serveoUrl);
              if (url != null && !found.isCompleted) found.complete(url);
            }, onError: (_) {});
        read(session.stdout.cast<List<int>>());
        read(session.stderr.cast<List<int>>());
        address = await found.future.timeout(timeout, onTimeout: () => throw SshError('$name не выдал ссылку за ${timeout.inSeconds} с.'));
      }
      return SshTunnel._(client, address, name);
    } catch (e) {
      client.close();
      if (e is SshError) rethrow;
      if (e is TimeoutException) throw SshError('$name не ответил за ${timeout.inSeconds} с.');
      throw SshError('$name: $e');
    }
  }

  // Один входящий запрос: соединяемся с HTTP-сервером телефона и гоним байты в обе стороны.
  static Future<void> _pipe(SSHForwardChannel channel, int localPort) async {
    try {
      final socket = await Socket.connect('127.0.0.1', localPort, timeout: const Duration(seconds: 5));
      socket.setOption(SocketOption.tcpNoDelay, true);
      channel.stream.listen(socket.add, onDone: socket.destroy, onError: (_) => socket.destroy(), cancelOnError: true);
      socket.listen((data) => channel.sink.add(data), onDone: () => channel.sink.close(), onError: (_) => channel.sink.close(), cancelOnError: true);
    } catch (_) {
      await channel.sink.close();
    }
  }

  @override
  Future<void> stop() async {
    markStopped();
    _client.close();
  }
}
