import 'dart:convert';

/// Свой сервер трансляции (VPS с MediaMTX из server/install.sh): к нему телефон может
/// подключаться напрямую, без ПК.
class OwnServer {
  OwnServer({required this.name, required this.host, this.rtspPort = 8554, required this.key});

  final String name;
  final String host;
  final int rtspPort;
  final String key;

  String get id => '$host:$rtspPort';

  /// Приём WebRTC (WHIP) на сервере лежит рядом с RTSP-портом: порт + 11.
  Uri get whip => Uri(scheme: 'http', host: host, port: rtspPort + 11, path: '/phone/whip');

  /// Ссылка для плеера в VRChat: стабильная, пока сервер на месте.
  String get viewLink => 'rtspt://$host:$rtspPort/phone';

  String get basicAuth => 'Basic ${base64Encode(utf8.encode('vrcast:$key'))}';

  Map<String, Object?> toJson() => {'name': name, 'host': host, 'rtspPort': rtspPort, 'key': key};

  factory OwnServer.fromJson(Map<String, dynamic> json) => OwnServer(
        name: '${json['name'] ?? json['host']}',
        host: '${json['host']}',
        rtspPort: (json['rtspPort'] as num?)?.toInt() ?? 8554,
        key: '${json['key'] ?? json['publishKey'] ?? ''}',
      );

  /// Проверка того, что ввёл человек; возвращает текст ошибки или null.
  static String? validate({required String host, required String port, required String key}) {
    final h = host.trim();
    if (h.isEmpty) return 'Введите адрес сервера';
    if (!RegExp(r'^[A-Za-z0-9.-]+$').hasMatch(h) && !RegExp(r'^\[[0-9A-Fa-f:]+\]$').hasMatch(h)) return 'Адрес: IP или доменное имя без http:// и порта';
    final p = int.tryParse(port.trim());
    if (p == null || p < 1 || p > 65524) return 'Порт — число от 1 до 65524';
    if (key.trim().isEmpty) return 'Введите ключ сервера';
    return null;
  }
}
