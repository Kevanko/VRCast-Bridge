import 'package:flutter/foundation.dart';

/// Журнал приложения (как журнал на ПК): что запускалось, какие были ошибки. Хранится в памяти, последние 500 строк.
class AppLog extends ChangeNotifier {
  static final AppLog instance = AppLog();

  final lines = <String>[];

  void add(String message) {
    final now = DateTime.now();
    String two(int v) => v.toString().padLeft(2, '0');
    final stamp = '${two(now.hour)}:${two(now.minute)}:${two(now.second)}';
    for (final line in message.split('\n')) {
      if (line.trim().isEmpty) continue;
      lines.add('$stamp  $line');
    }
    while (lines.length > 500) {
      lines.removeAt(0);
    }
    notifyListeners();
  }

  void clear() {
    lines.clear();
    notifyListeners();
  }

  String get text => lines.join('\n');

  /// Всё, что печатается через debugPrint, попадает и в журнал.
  static void capture() {
    final original = debugPrint;
    debugPrint = (String? message, {int? wrapWidth}) {
      if (message != null) instance.add(message);
      original(message, wrapWidth: wrapWidth);
    };
  }
}
