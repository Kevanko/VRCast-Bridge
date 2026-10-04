import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vrcast_remote/api.dart';
import 'package:vrcast_remote/broadcaster.dart';
import 'package:vrcast_remote/file_broadcast.dart';
import 'package:vrcast_remote/phone_host.dart';
import 'package:vrcast_remote/remote.dart';
import 'package:vrcast_remote/screens.dart';

void main() {
  testWidgets('настройки админа группы: включение, код привязки, подключённое устройство и отвязка', (tester) async {
    HttpOverrides.global = null; // настоящие сокеты: хост слушает порт
    SharedPreferences.setMockInitialValues({});
    await tester.runAsync(() => Prefs.instance.load());
    final broadcaster = Broadcaster(files: FileBroadcast(hold: null));
    final host = PhoneHost(broadcaster: broadcaster, advertise: false);
    PhoneHost.current = host;
    addTearDown(() async {
      PhoneHost.current = null;
      await tester.runAsync(host.stop);
      broadcaster.dispose();
    });

    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SingleChildScrollView(child: HostSettings()))));
    expect(find.text('Это устройство — админ группы'), findsOneWidget);
    expect(find.text('Код привязки'), findsNothing, reason: 'пока выключено, ничего лишнего');

    await tester.runAsync(() => host.start(port: 0));
    await tester.pump();
    expect(find.text('Код привязки'), findsOneWidget);
    final code = host.pairCode;
    expect(find.text('${code.substring(0, 3)} ${code.substring(3)}'), findsOneWidget);

    await tester.runAsync(() => Api(Uri.parse('http://127.0.0.1:${host.port}')).pair(code, 'Телефон друга'));
    await tester.pump();
    expect(find.text('Телефон друга'), findsOneWidget);
    expect(find.text('не в сети'), findsOneWidget);
    expect(find.text('${code.substring(0, 3)} ${code.substring(3)}'), findsNothing, reason: 'код сменился после привязки');

    host.unpair(Prefs.instance.hostDevices.single.id);
    await tester.pump();
    expect(find.text('Телефон друга'), findsNothing);
  });
}
