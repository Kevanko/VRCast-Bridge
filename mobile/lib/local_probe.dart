import 'package:flutter/services.dart';

/// Что Android знает о файле на телефоне: длительность и кадр для обложки (как превью у роликов на ПК).
/// null — файл не открылся или это не Android.
Future<({double duration, String? thumbnail})?> probeLocalFile(String path, String id) async {
  try {
    final reply = await const MethodChannel('vrcast/screen').invokeMethod<Map<Object?, Object?>>('probeFile', {'path': path, 'id': id});
    if (reply == null) return null;
    return (duration: (reply['duration'] as num?)?.toDouble() ?? 0, thumbnail: reply['thumbnail'] as String?);
  } catch (_) {
    return null;
  }
}
