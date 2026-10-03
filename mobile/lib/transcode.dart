import 'dart:async';

import 'dart:typed_data';

import 'package:flutter/services.dart';

import 'mp4.dart';

/// Качество эфира, как на ПК: размер картинки, кадры в секунду, битрейт. «Как в файле» — без перекодирования.
class VideoProfile {
  const VideoProfile({this.quality = 'copy', this.fps = 30, this.bitrateKbps = 0});

  static const copy = VideoProfile();
  static const qualities = {'copy': 'Как в файле', '480p': '480p', '720p': '720p', '1080p': '1080p'};

  final String quality; // copy | 480p | 720p | 1080p
  final int fps;
  final int bitrateKbps; // 0 — по умолчанию для размера и частоты кадров

  bool get isCopy => quality == 'copy';

  /// Размер кадра. Для «как в файле» (когда всё же нужно перекодировать) берётся 720p.
  (int, int) get size => switch (quality) { '480p' => (854, 480), '1080p' => (1920, 1080), _ => (1280, 720) };
  int get height => size.$2;

  int get bitrate {
    if (bitrateKbps > 0) return bitrateKbps * 1000;
    final base = switch (quality) { '480p' => 1500, '1080p' => 5000, _ => 3000 };
    return (base * (fps >= 50 ? 1.5 : 1.0)).round() * 1000;
  }

  @override
  bool operator ==(Object other) => other is VideoProfile && other.quality == quality && other.fps == fps && other.bitrateKbps == bitrateKbps;
  @override
  int get hashCode => Object.hash(quality, fps, bitrateKbps);
}

/// Что запросить у движка перекодирования на телефоне.
class EngineParams {
  EngineParams({
    this.videoSource,
    this.audioSource,
    this.startUs = 0,
    this.profile = const VideoProfile(quality: '720p'),
    this.volume = 1,
    this.speed = 1,
    this.audioBitrate = 128000,
    this.headers,
  });

  final String? videoSource; // файл или адрес; если нет картинки — чёрный кадр
  final String? audioSource; // отдельный источник звука (YouTube отдаёт картинку и звук врозь); иначе звук из videoSource
  final int startUs;
  final VideoProfile profile;
  final double volume;
  final double speed;
  final int audioBitrate;
  final Map<String, String>? headers;

  Map<String, Object?> toMap() => {
        'videoSource': videoSource,
        'audioSource': audioSource,
        'startUs': startUs,
        'width': profile.size.$1,
        'height': profile.size.$2,
        'fps': profile.fps,
        'videoBitrate': profile.bitrate,
        'audioBitrate': audioBitrate,
        'volume': volume,
        'speed': speed,
        'headers': headers,
      };
}

/// Один запуск движка. События — словари: vcfg/acfg (параметры кодеков), v (кадр), a (звук), end, error.
abstract class EngineSession {
  Stream<Map<String, dynamic>> get events;
  Future<void> pause();
  Future<void> resume();
  Future<void> stop();
  Future<void> setVolume(double value);
}

typedef EngineStarter = Future<EngineSession> Function(EngineParams params);

/// Настоящий движок на Android (MediaCodec): команды по одному каналу, кадры по другому.
class PlatformEngineSession implements EngineSession {
  PlatformEngineSession._(this.id);

  static const _control = MethodChannel('vrcast/engine');
  static final _frames = BasicMessageChannel<dynamic>('vrcast/engine/frames', const StandardMessageCodec());
  static final _sessions = <int, PlatformEngineSession>{};
  static final _early = <int, List<Map<String, dynamic>>>{}; // кадры могут прийти раньше, чем узнаем номер запуска
  static bool _hooked = false;

  final int id;
  final _controller = StreamController<Map<String, dynamic>>();

  static void _hook() {
    if (_hooked) return;
    _hooked = true;
    _frames.setMessageHandler((message) async {
      if (message is! Map) return null;
      final map = message.cast<String, dynamic>();
      final id = map['session'] as int?;
      if (id == null) return null;
      final session = _sessions[id];
      if (session == null) {
        (_early[id] ??= []).add(map);
      } else {
        session._add(map);
      }
      return null;
    });
  }

  void _add(Map<String, dynamic> map) {
    if (_controller.isClosed) return;
    _controller.add(map);
    if (map['type'] == 'end' || map['type'] == 'error') {
      _sessions.remove(id);
      _controller.close();
    }
  }

  static Future<EngineSession> start(EngineParams params) async {
    _hook();
    final id = await _control.invokeMethod<int>('start', params.toMap());
    final session = PlatformEngineSession._(id!);
    _sessions[id] = session;
    for (final map in _early.remove(id) ?? const <Map<String, dynamic>>[]) {
      session._add(map);
    }
    return session;
  }

  @override
  Stream<Map<String, dynamic>> get events => _controller.stream;

  @override
  Future<void> pause() => _control.invokeMethod<void>('pause');

  @override
  Future<void> resume() => _control.invokeMethod<void>('resume');

  @override
  Future<void> setVolume(double value) => _control.invokeMethod<void>('volume', {'value': value});

  @override
  Future<void> stop() async {
    _sessions.remove(id);
    try {
      await _control.invokeMethod<void>('stop');
    } catch (_) {}
    if (!_controller.isClosed) await _controller.close();
  }
}

/// Параметры кодеков, которые прислал движок, как «таблица кадров» для приёмников (RTSP, HLS): формат эфира один и тот же
/// для всех роликов, поэтому приёмник не переподключается при смене ролика.
Mp4Info engineInfo({required List<int> sps, required List<int> pps, required List<int> asc, int sampleRate = 48000, int channels = 2, double duration = 0}) {
  final video = Mp4Track(isVideo: true, timescale: 90000, samples: const [], sps: [Uint8ListX.of(sps)], pps: [Uint8ListX.of(pps)], nalLength: 4);
  final audio = Mp4Track(isVideo: false, timescale: sampleRate, samples: const [], asc: Uint8ListX.of(asc), sampleRate: sampleRate, channels: channels);
  return Mp4Info(video, audio);
}

class Uint8ListX {
  static Uint8List of(List<int> bytes) => bytes is Uint8List ? bytes : Uint8List.fromList(bytes);
}
