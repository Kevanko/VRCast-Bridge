import 'dart:async';
import 'dart:io';

/// Публичная ссылка в интернет на HTTP-сервер телефона (Cloudflare, Serveo и т. п.).
abstract class PublicTunnel {
  /// Адрес вида https://что-то.trycloudflare.com (без пути).
  String get url;

  /// Завершается, когда туннель остановился (сам или после stop).
  Future<void> get closed;

  Future<void> stop();

  /// Название сервиса для сообщений человеку.
  String get provider;

  bool _stopped = false;
  bool get stopped => _stopped;

  /// Пометить туннель остановленным (для наследников).
  void markStopped() => _stopped = true;

  /// Дождаться, пока адрес реально отдаёт ответ 200 по [path] (туннель появляется в сети не сразу).
  Future<bool> waitServes(String path, {Duration timeout = const Duration(seconds: 30)}) async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 6);
    final until = DateTime.now().add(timeout);
    try {
      while (!_stopped && DateTime.now().isBefore(until)) {
        try {
          final response = await (await client.getUrl(Uri.parse('$url$path'))).close().timeout(const Duration(seconds: 8));
          await response.drain<void>();
          if (response.statusCode == 200) return true;
        } catch (_) {}
        await Future<void>.delayed(const Duration(seconds: 1));
      }
    } finally {
      client.close(force: true);
    }
    return false;
  }
}
