import 'package:flutter/material.dart';

import 'api.dart';
import 'broadcaster.dart';
import 'remote.dart';
import 'screens.dart';

void main() => runApp(const VrcastRemoteApp());

/// Без растяжения и «резинки» при перетягивании за край (Android 12+ тянет содержимое без предела).
class NoStretchScrollBehavior extends MaterialScrollBehavior {
  const NoStretchScrollBehavior();
  @override
  Widget buildOverscrollIndicator(BuildContext context, Widget child, ScrollableDetails details) => child;
  @override
  ScrollPhysics getScrollPhysics(BuildContext context) => const ClampingScrollPhysics();
}

class VrcastRemoteApp extends StatelessWidget {
  const VrcastRemoteApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'VRCast Bridge',
        debugShowCheckedModeBanner: false,
        scrollBehavior: const NoStretchScrollBehavior(),
        theme: ThemeData(useMaterial3: true, brightness: Brightness.dark, colorSchemeSeed: accent, scaffoldBackgroundColor: const Color(0xFF0E0C18)),
        home: const Root(),
      );
}

/// Главный экран всегда один: с ПК или без него. Подключение к ПК только добавляет синхронизацию.
class Root extends StatefulWidget {
  const Root({super.key});
  @override
  State<Root> createState() => _RootState();
}

class _RootState extends State<Root> {
  Remote? _remote;
  // Эфир не зависит от связи с ПК: он общий для всех подключений и не прерывается при смене.
  final Broadcaster _broadcaster = Broadcaster();

  @override
  void initState() {
    super.initState();
    Prefs.instance.load().then((_) {
      final last = Prefs.instance.last;
      if (!mounted) return;
      if (last != null && Prefs.instance.autoConnect) {
        _connect(last.name, last.base);
      } else {
        setState(() => _remote = Remote.local(broadcaster: _broadcaster));
      }
    });
  }

  void _connect(String name, Uri base) {
    final previous = _remote;
    final remote = Remote(Api(base, token: Prefs.instance.tokens[base.toString()]), pcName: Prefs.instance.nameFor(base.authority, name), broadcaster: _broadcaster)..start();
    Prefs.instance.remember(name, base.toString());
    setState(() => _remote = remote);
    previous?.dispose();
  }

  void _disconnect() {
    final previous = _remote;
    Prefs.instance.leave();
    setState(() => _remote = Remote.local(broadcaster: _broadcaster));
    previous?.dispose();
  }

  @override
  void dispose() {
    _remote?.dispose();
    _broadcaster.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final remote = _remote;
    if (remote == null) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    return HomeScreen(key: ValueKey(remote), remote: remote, onConnect: _connect, onDisconnect: _disconnect);
  }
}
