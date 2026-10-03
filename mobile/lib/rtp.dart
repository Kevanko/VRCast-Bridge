import 'dart:convert';
import 'dart:typed_data';

import 'mp4.dart';

/// RTP-пакеты для H.264 (RFC 6184) и AAC (RFC 3640) из готовых кадров mp4: перекодирования нет.
class RtpStream {
  RtpStream(this.payloadType, this.clock, {int? ssrc, int? firstSequence, int? firstTimestamp})
      : ssrc = ssrc ?? 0x56524300 + payloadType,
        _sequence = firstSequence ?? 1000,
        timestampBase = firstTimestamp ?? 100000;

  final int payloadType;
  final int clock;
  final int ssrc;
  final int timestampBase;
  int _sequence;
  int packets = 0;
  int octets = 0;
  int lastTimestamp = 0;

  /// Время потока (секунды) → метка RTP.
  int timestampFor(double seconds) => (timestampBase + (seconds * clock).round()) & 0xFFFFFFFF;

  Uint8List packet(Uint8List payload, int timestamp, {required bool marker}) {
    final out = Uint8List(12 + payload.length);
    final data = ByteData.sublistView(out);
    out[0] = 0x80;
    out[1] = (marker ? 0x80 : 0) | payloadType;
    data.setUint16(2, _sequence);
    data.setUint32(4, timestamp);
    data.setUint32(8, ssrc);
    out.setRange(12, out.length, payload);
    _sequence = (_sequence + 1) & 0xFFFF;
    packets++;
    octets += payload.length;
    lastTimestamp = timestamp;
    return out;
  }

  /// Отчёт отправителя (RTCP SR): по нему приёмник сводит звук и картинку по времени.
  Uint8List senderReport(DateTime now) {
    final out = Uint8List(28);
    final data = ByteData.sublistView(out);
    out[0] = 0x80;
    out[1] = 200;
    data.setUint16(2, 6);
    data.setUint32(4, ssrc);
    final ms = now.toUtc().millisecondsSinceEpoch;
    data.setUint32(8, ms ~/ 1000 + 2208988800); // секунды с 1900 года
    data.setUint32(12, ((ms % 1000) * 4294967.296).round() & 0xFFFFFFFF);
    data.setUint32(16, lastTimestamp);
    data.setUint32(20, packets);
    data.setUint32(24, octets);
    return out;
  }
}

/// NAL-единицы кадра H.264 из mp4 (в файле перед каждой стоит её длина). Перед ключевым кадром ставятся SPS и PPS.
List<Uint8List> h264Nals(Mp4Track track, Uint8List sample, {required bool sync}) {
  final nals = <Uint8List>[];
  if (sync) {
    nals.addAll(track.sps);
    nals.addAll(track.pps);
  }
  var p = 0;
  final data = ByteData.sublistView(sample);
  while (p + track.nalLength <= sample.length) {
    var n = 0;
    for (var i = 0; i < track.nalLength; i++) {
      n = (n << 8) | data.getUint8(p + i);
    }
    p += track.nalLength;
    if (n <= 0 || p + n > sample.length) break;
    final type = sample[p] & 31;
    // Разделители и свои наборы параметров не нужны: нужные поставлены выше.
    if (type != 9 && !(sync && (type == 7 || type == 8))) nals.add(Uint8List.sublistView(sample, p, p + n));
    p += n;
  }
  return nals;
}

/// Кадр H.264 → полезные нагрузки RTP (RFC 6184): малые NAL целиком, крупные режутся на FU-A.
List<Uint8List> h264Payloads(Mp4Track track, Uint8List sample, {required bool sync, int maxPayload = 1200}) {
  final nals = h264Nals(track, sample, sync: sync);
  final out = <Uint8List>[];
  for (final nal in nals) {
    if (nal.length <= maxPayload) {
      out.add(nal);
      continue;
    }
    final indicator = (nal[0] & 0xE0) | 28;
    final type = nal[0] & 31;
    var at = 1;
    while (at < nal.length) {
      final take = (nal.length - at) < maxPayload - 2 ? nal.length - at : maxPayload - 2;
      final first = at == 1, last = at + take == nal.length;
      final chunk = Uint8List(2 + take);
      chunk[0] = indicator;
      chunk[1] = (first ? 0x80 : 0) | (last ? 0x40 : 0) | type;
      chunk.setRange(2, 2 + take, nal, at);
      out.add(chunk);
      at += take;
    }
  }
  return out;
}

/// Кадр AAC → нагрузка RTP в режиме AAC-hbr (заголовок AU из 16 бит).
Uint8List aacPayload(Uint8List frame) {
  final out = Uint8List(4 + frame.length);
  final data = ByteData.sublistView(out);
  data.setUint16(0, 16);
  data.setUint16(2, frame.length << 3);
  out.setRange(4, out.length, frame);
  return out;
}

/// Описание потока для ANNOUNCE.
String buildSdp({Mp4Track? video, Mp4Track? audio, String name = 'VRCast phone'}) {
  final lines = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=$name', 'c=IN IP4 0.0.0.0', 't=0 0'];
  var stream = 0;
  if (video != null) {
    final sps = video.sps.first;
    final profile = [sps[1], sps[2], sps[3]].map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    lines.addAll([
      'm=video 0 RTP/AVP 96',
      'a=rtpmap:96 H264/90000',
      'a=fmtp:96 packetization-mode=1;sprop-parameter-sets=${base64.encode(sps)},${base64.encode(video.pps.first)};profile-level-id=$profile',
      'a=control:streamid=${stream++}',
    ]);
  }
  if (audio != null) {
    final config = audio.asc!.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    lines.addAll([
      'm=audio 0 RTP/AVP 97',
      'a=rtpmap:97 MPEG4-GENERIC/${audio.sampleRate}/${audio.channels}',
      'a=fmtp:97 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=$config',
      'a=control:streamid=${stream++}',
    ]);
  }
  return '${lines.join('\r\n')}\r\n';
}
