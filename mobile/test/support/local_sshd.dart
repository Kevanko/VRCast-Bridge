import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Настоящий sshd на свободном порту от имени текущего пользователя (по ключу): проверяем реальную работу по SSH без ВПС.
class LocalSshd {
  late Directory dir;
  late Process process;
  late int port;
  late String privateKey;
  late String publicKeyFingerprint;

  static bool get available => File('/usr/sbin/sshd').existsSync() && Process.runSync('which', ['ssh-keygen']).exitCode == 0;

  Future<void> start() async {
    dir = await Directory.systemTemp.createTemp('vrcast-sshd');
    Future<void> keygen(String name) async {
      final r = await Process.run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', '${dir.path}/$name']);
      expect(r.exitCode, 0, reason: '${r.stderr}');
    }

    await keygen('host');
    await keygen('client');
    privateKey = File('${dir.path}/client').readAsStringSync();
    File('${dir.path}/authorized_keys').writeAsStringSync(File('${dir.path}/client.pub').readAsStringSync());
    final probe = await ServerSocket.bind('127.0.0.1', 0);
    port = probe.port;
    await probe.close();
    File('${dir.path}/sshd_config').writeAsStringSync([
      'Port $port', 'ListenAddress 127.0.0.1', 'HostKey ${dir.path}/host', 'PidFile ${dir.path}/pid', 'AuthorizedKeysFile ${dir.path}/authorized_keys',
      'PasswordAuthentication no', 'PubkeyAuthentication yes', 'UsePAM no', 'StrictModes no', 'LogLevel ERROR', 'AllowTcpForwarding yes', 'GatewayPorts no', '',
    ].join('\n'));
    process = await Process.start('/usr/sbin/sshd', ['-D', '-e', '-f', '${dir.path}/sshd_config']);
    process.stdout.drain<void>();
    process.stderr.drain<void>();
    for (var i = 0; i < 50; i++) {
      try {
        (await Socket.connect('127.0.0.1', port, timeout: const Duration(milliseconds: 200))).destroy();
        return;
      } catch (_) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }
    }
    fail('sshd не запустился');
  }

  /// Разрешить ещё один открытый ключ (строка `ssh-ed25519 AAAA…`).
  void authorize(String publicKeyLine) => File('${dir.path}/authorized_keys').writeAsStringSync('\n$publicKeyLine\n', mode: FileMode.append);

  Future<void> stop() async {
    process.kill();
    await process.exitCode;
    await dir.delete(recursive: true);
  }

  String get user => Platform.environment['USER'] ?? Process.runSync('whoami', []).stdout.toString().trim();
}

