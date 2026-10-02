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

/// Последний выбранный ПК запоминаем: при следующем запуске подключаемся сразу.
class SavedPc {
  static const _key = 'lastPc';
  static Future<({String name, String url})?> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getStringList(_key);
    return raw == null || raw.length != 2 ? null : (name: raw[0], url: raw[1]);
  }

  static Future<void> save(String name, String url) async => (await SharedPreferences.getInstance()).setStringList(_key, [name, url]);
  static Future<void> clear() async => (await SharedPreferences.getInstance()).remove(_key);
}
