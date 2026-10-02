import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'models.dart';

enum Link { idle, connecting, online, offline }

/// Соединение с одним ПК: живое состояние по SSE и команды.
class Remote extends ChangeNotifier {
  Remote(this.api, {this.pcName = ''});

  final Api api;
  final String pcName;
  BridgeState? state;
  Link link = Link.idle;
  String? error;
  bool _closed = false;
  Timer? _tick;

  /// Подключаемся и держим соединение: при обрыве пробуем снова.
  void start() {
    if (link != Link.idle) return;
    _loop();
    _tick = Timer.periodic(const Duration(milliseconds: 500), (_) {
      if (state?.isPlaying == true) notifyListeners();
    });
  }

  Future<void> _loop() async {
    var delay = 1;
    while (!_closed) {
      link = state == null ? Link.connecting : Link.offline;
      notifyListeners();
      try {
        await for (final next in api.events()) {
          if (_closed) return;
          state = next; link = Link.online; error = null; delay = 1;
          notifyListeners();
        }
      } catch (e) {
        error = '$e';
      }
      if (_closed) return;
      link = Link.offline;
      notifyListeners();
      await Future<void>.delayed(Duration(seconds: delay));
      delay = delay < 8 ? delay * 2 : 8;
    }
  }

  /// Команда: ошибку показываем, а состояние придёт событием.
  Future<String?> run(Future<void> Function() action) async {
    try {
      await action();
      return null;
    } catch (e) {
      return '$e';
    }
  }

  Future<String?> playback(String action, [Map<String, Object?> extra = const {}]) => run(() => api.playback(action, extra));

  @override
  void dispose() {
    _closed = true;
    _tick?.cancel();
    api.close();
    super.dispose();
  }
}

class SavedPc {
  SavedPc(this.name, this.url);
  final String name;
  final String url;
  Uri get base => Uri.parse(url);
  @override
  bool operator ==(Object other) => other is SavedPc && other.url == url;
  @override
  int get hashCode => url.hashCode;
}

/// Настройки приложения и запомненные компьютеры.
class Prefs extends ChangeNotifier {
  static final Prefs instance = Prefs();

  bool autoConnect = true;
  bool preview = true;
  int defaultPort = 4717;
  List<SavedPc> pcs = [];
  SavedPc? last;

  Future<void> load() async {
    final p = await SharedPreferences.getInstance();
    autoConnect = p.getBool('autoConnect') ?? true;
    preview = p.getBool('preview') ?? true;
    defaultPort = p.getInt('defaultPort') ?? 4717;
    pcs = [for (final raw in p.getStringList('pcs') ?? const []) if (raw.contains('\n')) SavedPc(raw.split('\n').first, raw.split('\n').last)];
    final l = p.getStringList('lastPc');
    last = l != null && l.length == 2 ? SavedPc(l[0], l[1]) : null;
    notifyListeners();
  }

  Future<void> _save() async {
    final p = await SharedPreferences.getInstance();
    await p.setBool('autoConnect', autoConnect);
    await p.setBool('preview', preview);
    await p.setInt('defaultPort', defaultPort);
    await p.setStringList('pcs', [for (final pc in pcs) '${pc.name}\n${pc.url}']);
    last == null ? await p.remove('lastPc') : await p.setStringList('lastPc', [last!.name, last!.url]);
  }

  void update(void Function() change) {
    change();
    notifyListeners();
    _save();
  }

  void remember(String name, String url) => update(() {
        final pc = SavedPc(name, url);
        pcs = [pc, ...pcs.where((e) => e != pc)].take(10).toList();
        last = pc;
      });

  void forget(SavedPc pc) => update(() {
        pcs = pcs.where((e) => e != pc).toList();
        if (last == pc) last = null;
      });

  void leave() => update(() => last = null);
}
