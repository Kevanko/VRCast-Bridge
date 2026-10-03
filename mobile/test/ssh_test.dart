import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vrcast_remote/own_server.dart';
import 'package:vrcast_remote/ssh.dart';

import 'support/local_sshd.dart';

void main() {
  late LocalSshd sshd;
  final skip = LocalSshd.available ? false : 'нужен sshd';

  setUpAll(() async {
    if (LocalSshd.available) {
      sshd = LocalSshd();
      await sshd.start();
    }
  });
  tearDownAll(() async {
    if (LocalSshd.available) await sshd.stop();
  });

  const fakeInstaller = r'''
echo "установка (проверочная)…"
echo "порт $VRCAST_PORT, машинный режим $VRCAST_MACHINE"
echo "VRCAST_OK ip=203.0.113.9 port=$VRCAST_PORT hls=$(( VRCAST_PORT + 10 )) key=test-key-123"
''';

  test('установка на сервер по SSH: скрипт получает порт и машинный режим, из ответа берутся адрес, порт и ключ; ключ сервера запоминается', () async {
    final server = await deployServer(host: '127.0.0.1:${sshd.port}', user: sshd.user, privateKey: sshd.privateKey, script: fakeInstaller, rtspPort: 9554, name: 'Мой VPS');
    expect(server.name, 'Мой VPS');
    expect(server.host, '127.0.0.1');
    expect(server.rtspPort, 9554);
    expect(server.key, 'test-key-123');
    expect(server.sshPort, sshd.port);
    expect(server.user, sshd.user);
    expect(server.hostKey, startsWith('MD5:'), reason: 'отпечаток ключа сервера запомнен для проверки дальше');
    // Сохраняется и читается обратно (пароль не сохраняется).
    final back = OwnServer.fromJson(server.toJson());
    expect([back.sshPort, back.user, back.hostKey], [server.sshPort, server.user, server.hostKey]);
    expect(server.toJson().toString(), isNot(contains('пароль')));

    // Повторная установка с запомненным ключом проходит, с чужим — отказ до отправки пароля.
    await deployServer(host: '127.0.0.1:${sshd.port}', user: sshd.user, privateKey: sshd.privateKey, script: fakeInstaller, knownHostKey: server.hostKey);
    await expectLater(deployServer(host: '127.0.0.1:${sshd.port}', user: sshd.user, privateKey: sshd.privateKey, script: fakeInstaller, knownHostKey: 'MD5:00:11'),
        throwsA(isA<SshError>().having((e) => e.message, 'text', contains('Ключ сервера изменился'))));
  }, skip: skip, timeout: const Timeout(Duration(minutes: 1)));

  test('ошибки установки: неверный пароль, сервер сам сообщил об ошибке, нет данных, неверный адрес, порт не отвечает', () async {
    await expectLater(deployServer(host: '127.0.0.1:${sshd.port}', user: sshd.user, password: 'не-тот', script: fakeInstaller),
        throwsA(isA<SshError>().having((e) => e.message, 'text', contains('Неверный пароль'))));
    await expectLater(deployServer(host: '127.0.0.1:${sshd.port}', user: sshd.user, privateKey: sshd.privateKey, script: 'echo "VRCAST_ERR Нужен root: запустите установку от root"'),
        throwsA(isA<SshError>().having((e) => e.message, 'text', contains('Нужен root'))));
    await expectLater(deployServer(host: '127.0.0.1:${sshd.port}', user: sshd.user, privateKey: sshd.privateKey, script: 'echo "VRCAST_OK без данных"'),
        throwsA(isA<SshError>().having((e) => e.message, 'text', contains('не вернул данные'))));
    await expectLater(deployServer(host: '127.0.0.1:${sshd.port}', user: sshd.user, privateKey: sshd.privateKey, script: 'echo "что-то пошло не так" >&2; exit 3'),
        throwsA(isA<SshError>().having((e) => e.message, 'text', contains('что-то пошло не так'))));
    await expectLater(deployServer(host: '-bad host', script: fakeInstaller, password: 'x'), throwsA(isA<SshError>().having((e) => e.message, 'text', contains('Адрес сервера'))));
    await expectLater(deployServer(host: '127.0.0.1', script: fakeInstaller), throwsA(isA<SshError>().having((e) => e.message, 'text', contains('пароль'))));
    final closed = await ServerSocket.bind('127.0.0.1', 0);
    final deadPort = closed.port;
    await closed.close();
    await expectLater(deployServer(host: '127.0.0.1:$deadPort', password: 'x', script: fakeInstaller), throwsA(isA<SshError>().having((e) => e.message, 'text', contains('не отвечает по SSH'))));
  }, skip: skip, timeout: const Timeout(Duration(minutes: 1)));

  test('удаление с сервера: порт передаётся скрипту, ответ VRCAST_OK принимается; без пароля — отказ; ключ сервера сверяется', () async {
    final server = OwnServer(name: 'x', host: '127.0.0.1', rtspPort: 9554, key: 'k', sshPort: sshd.port, user: sshd.user);
    // Скрипт подменён безопасным: настоящий вызывает systemctl, которому без root нужен пароль, и на этой машине повис бы.
    await removeFromServer(server, privateKey: sshd.privateKey, script: r'''
echo "порт $VRCAST_PORT_ARG"
test "$VRCAST_PORT_ARG" = 9554 && echo "VRCAST_OK removed"
''');
    await expectLater(removeFromServer(server, privateKey: sshd.privateKey, script: 'echo "VRCAST_ERR диск только для чтения"'), throwsA(isA<SshError>().having((e) => e.message, 'text', contains('диск'))));
    await expectLater(removeFromServer(server), throwsA(isA<SshError>()));
    await expectLater(removeFromServer(OwnServer(name: 'x', host: '127.0.0.1', key: 'k', sshPort: sshd.port, user: sshd.user, hostKey: 'MD5:aa'), privateKey: sshd.privateKey),
        throwsA(isA<SshError>().having((e) => e.message, 'text', contains('Ключ сервера изменился'))));
  }, skip: skip, timeout: const Timeout(Duration(minutes: 1)));

  test('настоящий скрипт удаления: останавливает службу, убирает каталог и правила, отвечает VRCAST_OK (локально, команды подставные)', () async {
    final sandbox = await Directory.systemTemp.createTemp('vrcast-rm');
    addTearDown(() => sandbox.delete(recursive: true));
    // Подставные systemctl, ufw и firewall-cmd, чтобы скрипт ничего не трогал в системе и не ждал пароля.
    final bin = Directory('${sandbox.path}/bin')..createSync();
    final log = File('${sandbox.path}/calls.log');
    for (final name in ['systemctl', 'ufw', 'firewall-cmd']) {
      final tool = File('${bin.path}/$name')..writeAsStringSync('#!/bin/sh\necho "$name \$@" >> ${log.path}\n[ "$name" = ufw ] && [ "\$1" = status ] && echo "Status: active"\n[ "$name" = firewall-cmd ] && [ "\$1" = --state ] && echo running\nexit 0\n');
      await Process.run('chmod', ['755', tool.path]);
    }
    final script = File('${sandbox.path}/remove.sh')..writeAsStringSync(removeScript);
    final r = await Process.run('bash', [script.path], environment: {'PATH': '${bin.path}:${Platform.environment['PATH']}', 'VRCAST_PORT_ARG': '9554'});
    expect('${r.stdout}', contains('VRCAST_OK removed'), reason: '${r.stderr}');
    final calls = log.readAsStringSync();
    expect(calls, contains('systemctl stop vrcast-relay'));
    expect(calls, contains('systemctl disable vrcast-relay'));
    expect(calls, contains('ufw delete allow 9554/tcp'));
    expect(calls, contains('ufw delete allow 9564/tcp'), reason: 'второе правило — порт HLS (порт + 10)');
    expect(calls, contains('firewall-cmd --permanent --remove-port=9554/tcp'));
    expect(calls, contains('firewall-cmd --reload'));
  });

  test('скрипт установки в приложении тот же, что в репозитории, и синтаксически верен', () async {
    final bundled = File('assets/install.sh').readAsStringSync();
    expect(bundled, File('../server/install.sh').readAsStringSync(), reason: 'после правки server/install.sh скопируйте его в mobile/assets/install.sh');
    expect((await Process.run('bash', ['-n', 'assets/install.sh'])).exitCode, 0);
    final removal = File('${Directory.systemTemp.path}/vrcast-remove-${DateTime.now().microsecondsSinceEpoch}.sh')..writeAsStringSync(removeScript);
    addTearDown(removal.deleteSync);
    expect((await Process.run('bash', ['-n', removal.path])).exitCode, 0);
  });
}
