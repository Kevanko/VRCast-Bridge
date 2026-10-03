import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vrcast_remote/app_log.dart';

void main() {
  test('журнал: строки с временем, лимит в 500, очистка и перехват debugPrint', () {
    final log = AppLog();
    log.add('Эфир запущен\nвторая строка');
    expect(log.lines, hasLength(2));
    expect(log.lines.first, matches(RegExp(r'^\d\d:\d\d:\d\d  Эфир запущен$')));
    for (var i = 0; i < 600; i++) {
      log.add('строка $i');
    }
    expect(log.lines, hasLength(500));
    expect(log.lines.last, endsWith('строка 599'));
    expect(log.text.split('\n'), hasLength(500));
    log.add('   ');
    expect(log.lines, hasLength(500), reason: 'пустые строки не пишутся');
    log.clear();
    expect(log.lines, isEmpty);

    final saved = debugPrint;
    addTearDown(() => debugPrint = saved);
    AppLog.instance.clear();
    AppLog.capture();
    debugPrint('привет из debugPrint');
    expect(AppLog.instance.lines.single, endsWith('привет из debugPrint'));
  });
}
