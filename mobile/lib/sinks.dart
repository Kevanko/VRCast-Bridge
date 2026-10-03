import 'dart:typed_data';

import 'mp4.dart';
import 'rtp.dart';
import 'rtsp_session.dart';

/// Куда уходят кадры эфира. Один и тот же планировщик отдаёт их либо на RTSP-сервер (свой VPS), либо в HLS (бесплатная ссылка).
/// Время кадров — секунды на общей шкале потока: она не идёт назад при смене файла и перемотке.
abstract class Sink {
  bool get closed;

  /// Можно ли продолжить этот же сеанс с файлом, у которого такие параметры кодеков.
  bool compatible(Mp4Info info);

  /// Начался новый файл или отрезок (после перемотки): для HLS это разрыв в потоке.
  void begin(Mp4Info info);

  void video(Mp4Track track, Uint8List data, {required double pts, required double dts, required bool sync});
  void audio(Mp4Track track, Uint8List data, {required double pts});

  /// Раз в пару секунд: отчёты отправителя, по которым приёмник сводит звук и картинку.
  void report(DateTime now);
  Future<void> flush();
  Future<void> keepAlive();
  Future<void> close();
}

/// Эфир на RTSP-сервер: H.264 и AAC уходят как есть в RTP.
class RtspSink implements Sink {
  RtspSink(this.out, Mp4Info info)
      : key = info.configKey,
        _video = info.video == null ? null : RtpStream(96, 90000),
        _audio = info.audio == null ? null : RtpStream(97, info.audio!.sampleRate),
        _videoTrack = info.video != null ? 0 : -1,
        _audioTrack = info.video != null && info.audio != null ? 1 : (info.audio != null ? 0 : -1);

  final RtspOut out;
  final String key;
  final RtpStream? _video;
  final RtpStream? _audio;
  final int _videoTrack;
  final int _audioTrack;

  @override
  bool get closed => out.closed;

  @override
  bool compatible(Mp4Info info) => info.configKey == key;

  @override
  void begin(Mp4Info info) {}

  @override
  void video(Mp4Track track, Uint8List data, {required double pts, required double dts, required bool sync}) {
    final rtp = _video!;
    final payloads = h264Payloads(track, data, sync: sync);
    final timestamp = rtp.timestampFor(pts);
    for (var k = 0; k < payloads.length; k++) {
      out.sendRtp(_videoTrack, rtp.packet(payloads[k], timestamp, marker: k == payloads.length - 1));
    }
  }

  @override
  void audio(Mp4Track track, Uint8List data, {required double pts}) {
    final rtp = _audio!;
    out.sendRtp(_audioTrack, rtp.packet(aacPayload(data), rtp.timestampFor(pts), marker: true));
  }

  @override
  void report(DateTime now) {
    if (_video != null) out.sendRtcp(_videoTrack, _video.senderReport(now));
    if (_audio != null) out.sendRtcp(_audioTrack, _audio.senderReport(now));
  }

  @override
  Future<void> flush() => out.flush();

  @override
  Future<void> keepAlive() => out.keepAlive();

  @override
  Future<void> close() => out.close();
}
