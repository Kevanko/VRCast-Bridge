import 'package:flutter/material.dart';

import 'api.dart';
import 'remote.dart';
import 'screens.dart';

void main() => runApp(const VrcastRemoteApp());

class VrcastRemoteApp extends StatelessWidget {
  const VrcastRemoteApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'VRCast Bridge',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(useMaterial3: true, brightness: Brightness.dark, colorSchemeSeed: accent, scaffoldBackgroundColor: const Color(0xFF0E0C18)),
        home: const Root(),
      );
}

/// Либо выбор ПК, либо пульт для выбранного.
class Root extends StatefulWidget {
  const Root({super.key});
  @override
  State<Root> createState() => _RootState();
}

class _RootState extends State<Root> {
  Remote? _remote;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    SavedPc.load().then((saved) {
      if (saved != null) _connect(saved.name, Uri.parse(saved.url));
      if (mounted) setState(() => _loading = false);
    });
  }

  void _connect(String name, Uri base) {
    _remote?.dispose();
    final remote = Remote(Api(base), pcName: name)..start();
    SavedPc.save(name, base.toString());
    setState(() => _remote = remote);
  }

  void _disconnect() {
    _remote?.dispose();
    SavedPc.clear();
    setState(() => _remote = null);
  }

  @override
  void dispose() {
    _remote?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    final remote = _remote;
    return remote == null ? ConnectScreen(onPick: _connect) : HomeScreen(remote: remote, onDisconnect: _disconnect);
  }
}
