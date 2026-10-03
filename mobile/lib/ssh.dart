import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dartssh2/dartssh2.dart';

import 'own_server.dart';

class SshError implements Exception {
  SshError(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Отпечаток ключа сервера для запоминания при первом подключении (как отпечаток в программе на ПК).
String hostKeyText(Uint8List fingerprint) => 'MD5:${fingerprint.map((b) => b.toRadixString(16).padLeft(2, '0')).join(':')}';

/// Подключение по SSH с паролем или ключом. Ключ сервера запоминается при первом подключении и сверяется дальше:
/// подменённый сервер пароль не получит.
Future<SSHClient> openSsh({
  required String host,
  int port = 22,
  String user = 'root',
  String? password,
  String? privateKey,
  String? expectedHostKey,
  void Function(String hostKey)? onHostKey,
  bool answerPrompts = false,
  Duration timeout = const Duration(seconds: 20),
}) async {
  final SSHSocket socket;
  try {
    socket = await SSHSocket.connect(host, port, timeout: timeout);
  } catch (e) {
    throw SshError('Сервер не отвечает по SSH ($host:$port). Проверьте адрес и порт.');
  }
  var changed = false;
  final client = SSHClient(
    socket,
    username: user,
    onPasswordRequest: password == null ? null : () => password,
    identities: privateKey == null || privateKey.trim().isEmpty ? null : SSHKeyPair.fromPem(privateKey),
    // Бесплатные сервисы (Serveo) пускают без регистрации через «интерактивный» вход с пустыми ответами.
    onUserInfoRequest: answerPrompts ? (request) => [for (final _ in request.prompts) ''] : null,
    onVerifyHostKey: (type, fingerprint) {
      final seen = hostKeyText(fingerprint);
      onHostKey?.call(seen);
      if (expectedHostKey == null || expectedHostKey.isEmpty || expectedHostKey == seen) return true;
      changed = true;
      return false;
    },
  );
  try {
    await client.authenticated.timeout(timeout);
    return client;
  } catch (e) {
    client.close();
    if (changed || e is SSHHostkeyError) throw SshError('Ключ сервера изменился. Это может быть другой сервер: пароль не отправлен.');
    if (e is SSHAuthFailError || e is SSHAuthAbortError) throw SshError(privateKey == null ? 'Неверный пароль root.' : 'Сервер не принял ключ.');
    if (e is TimeoutException) throw SshError('Сервер не ответил за ${timeout.inSeconds} с.');
    throw SshError('Не удалось подключиться по SSH: $e');
  }
}

/// Выполнить скрипт на сервере (передаётся в `bash -s`, пароль и скрипт в списке процессов не видны).
Future<String> runScript(SSHClient client, String script, {Duration timeout = const Duration(minutes: 4)}) async {
  final session = await client.execute('bash -s');
  final out = StringBuffer(), err = StringBuffer();
  session.stdout.cast<List<int>>().transform(utf8.decoder).listen(out.write);
  session.stderr.cast<List<int>>().transform(utf8.decoder).listen(err.write);
  session.stdin.add(utf8.encode(script));
  await session.stdin.close();
  try {
    await session.done.timeout(timeout);
  } on TimeoutException {
    session.close();
    throw SshError('Сервер не закончил за ${timeout.inMinutes} мин.');
  }
  // Даём дочитаться хвосту вывода.
  await Future<void>.delayed(const Duration(milliseconds: 50));
  final failure = RegExp(r'VRCAST_ERR ([^\n]*)').firstMatch(out.toString());
  if (failure != null) throw SshError(failure.group(1)!.trim());
  if (!out.toString().contains('VRCAST_OK')) {
    final lines = (err.isEmpty ? out : err).toString().trim().split(RegExp(r'\r?\n')).where((l) => l.isNotEmpty);
    final reason = lines.isEmpty ? 'сервер не ответил' : lines.last;
    throw SshError(RegExp(r'access denied|authentication|password', caseSensitive: false).hasMatch(reason) ? 'Неверный пароль root.' : (reason.length > 300 ? reason.substring(0, 300) : reason));
  }
  return out.toString();
}

/// Скрипт удаления: трогает только то, что поставил установщик (служба, каталог и два правила файрвола).
const removeScript = r'''
set -u
PORT="${VRCAST_PORT_ARG:-8554}"
systemctl stop vrcast-relay 2>/dev/null || true
systemctl disable vrcast-relay 2>/dev/null || true
rm -f /etc/systemd/system/vrcast-relay.service
systemctl daemon-reload 2>/dev/null || true
rm -rf /opt/vrcast-relay /usr/local/bin/vrcast
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw delete allow "$PORT/tcp" >/dev/null 2>&1 || true
  ufw delete allow "$(( PORT + 10 ))/tcp" >/dev/null 2>&1 || true
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --remove-port="$PORT/tcp" >/dev/null 2>&1 || true
  firewall-cmd --permanent --remove-port="$(( PORT + 10 ))/tcp" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi
echo "VRCAST_OK removed"
''';

/// Поставить сервер на VPS тем же server/install.sh, что и на ПК. Возвращает готовый сервер для списка.
/// [host] можно с портом SSH: `1.2.3.4:2222`.
Future<OwnServer> deployServer({
  required String host,
  required String script,
  String user = 'root',
  String? password,
  String? privateKey,
  int rtspPort = 8554,
  String name = '',
  String? knownHostKey,
}) async {
  final parts = host.trim().replaceFirst(RegExp(r'^ssh://', caseSensitive: false), '').split(':');
  final address = parts.first;
  final sshPort = parts.length > 1 ? int.tryParse(parts[1]) ?? 22 : 22;
  if (address.isEmpty || !RegExp(r'^[a-z0-9][a-z0-9.-]*$', caseSensitive: false).hasMatch(address)) throw SshError('Адрес сервера: только буквы, цифры, точки и дефис.');
  if ((password ?? '').isEmpty && (privateKey ?? '').trim().isEmpty) throw SshError('Укажите пароль root.');
  if (rtspPort < 1 || rtspPort > 65524) throw SshError('Порт сервера: число от 1 до 65524.');
  String? seen;
  final client = await openSsh(host: address, port: sshPort, user: user, password: password, privateKey: privateKey, expectedHostKey: knownHostKey, onHostKey: (k) => seen = k);
  try {
    final output = await runScript(client, 'VRCAST_MACHINE=1\nVRCAST_PORT=$rtspPort\n$script');
    final result = RegExp(r'VRCAST_OK ip=(\S+) port=(\d+) hls=(\d+) key=(\S+)').firstMatch(output);
    if (result == null) throw SshError('Сервер не вернул данные подключения.');
    return OwnServer(
      name: name.trim().isEmpty ? address : name.trim(),
      host: address,
      rtspPort: int.parse(result.group(2)!),
      key: result.group(4)!,
      sshPort: sshPort,
      user: user,
      hostKey: seen ?? knownHostKey ?? '',
    );
  } finally {
    client.close();
  }
}

/// Убрать с сервера всё, что поставила программа. Без пароля сервер просто исчезает из списка, а на машине остаётся как был.
Future<void> removeFromServer(OwnServer server, {String? password, String? privateKey, String script = removeScript}) async {
  if ((password ?? '').isEmpty && (privateKey ?? '').trim().isEmpty) throw SshError('Укажите пароль root.');
  final client = await openSsh(host: server.host, port: server.sshPort, user: server.user, password: password, privateKey: privateKey, expectedHostKey: server.hostKey);
  try {
    await runScript(client, 'VRCAST_PORT_ARG=${server.rtspPort}\n$script', timeout: const Duration(seconds: 90));
  } finally {
    client.close();
  }
}
