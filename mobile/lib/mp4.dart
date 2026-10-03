import 'dart:io';
import 'dart:typed_data';

/// Разбор mp4/mov: таблицы кадров и параметры H.264 и AAC. Видео не перекодируется: кадры уходят на сервер как есть,
/// поэтому подходят файлы с H.264 и AAC (так снимают и сохраняют почти все телефоны).
class Mp4Unsupported implements Exception {
  Mp4Unsupported(this.message);
  final String message;
  @override
  String toString() => message;
}

class Mp4Sample {
  const Mp4Sample(this.offset, this.size, this.dts, this.cts, this.sync);
  final int offset;
  final int size;
  final int dts; // в единицах timescale дорожки
  final int cts;
  final bool sync;
}

class Mp4Track {
  Mp4Track({required this.isVideo, required this.timescale, required this.samples, this.sps = const [], this.pps = const [], this.nalLength = 4, this.asc, this.sampleRate = 0, this.channels = 0});

  final bool isVideo;
  final int timescale;
  final List<Mp4Sample> samples;
  // H.264
  final List<Uint8List> sps;
  final List<Uint8List> pps;
  final int nalLength;
  // AAC
  final Uint8List? asc;
  final int sampleRate;
  final int channels;

  double seconds(int units) => units / timescale;
  double get duration => samples.isEmpty ? 0 : seconds(samples.last.dts + (samples.length > 1 ? samples.last.dts - samples[samples.length - 2].dts : 0));

  /// Что должно совпасть, чтобы два файла шли в одном RTSP-сеансе без переподключения.
  String get configKey => isVideo
      ? 'v:${sps.map(_hex).join()}:${pps.map(_hex).join()}'
      : 'a:${asc == null ? '' : _hex(asc!)}';
}

String _hex(List<int> bytes) => bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

class Mp4Info {
  Mp4Info(this.video, this.audio);
  final Mp4Track? video;
  final Mp4Track? audio;
  double get duration => [video?.duration ?? 0, audio?.duration ?? 0].reduce((a, b) => a > b ? a : b);
  String get configKey => '${video?.configKey ?? 'v:none'}|${audio?.configKey ?? 'a:none'}';
}

class _Box {
  _Box(this.type, this.start, this.end, this.headerLength);
  final String type;
  final int start; // начало самой коробки (с заголовком)
  final int end;
  final int headerLength;
  int get dataStart => start + headerLength;
}

/// Прочитать таблицы файла. Большие данные (сами кадры) не загружаются — только moov.
Future<Mp4Info> readMp4(String path) async {
  final file = await File(path).open();
  try {
    final length = await file.length();
    Uint8List? moov;
    var position = 0;
    while (position + 8 <= length) {
      await file.setPosition(position);
      final header = await file.read(16);
      if (header.length < 8) break;
      final data = ByteData.sublistView(header);
      var size = data.getUint32(0);
      final type = String.fromCharCodes(header.sublist(4, 8));
      var headerLength = 8;
      if (size == 1) {
        if (header.length < 16) break;
        size = data.getUint64(8);
        headerLength = 16;
      } else if (size == 0) {
        size = length - position;
      }
      if (size < headerLength) break;
      if (type == 'moov') {
        await file.setPosition(position + headerLength);
        moov = await file.read(size - headerLength);
        break;
      }
      position += size;
    }
    if (moov == null) throw Mp4Unsupported('Это не mp4 или файл не дописан: нет таблиц кадров');
    return parseMoov(moov);
  } finally {
    await file.close();
  }
}

/// Разбор содержимого moov (без заголовка коробки).
Mp4Info parseMoov(Uint8List moov) {
  Mp4Track? video, audio;
  for (final trak in _children(moov, 0, moov.length).where((b) => b.type == 'trak')) {
    final track = _parseTrak(moov, trak);
    if (track == null) continue;
    if (track.isVideo) {
      video ??= track;
    } else {
      audio ??= track;
    }
  }
  if (video == null && audio == null) throw Mp4Unsupported('В файле нет H.264 или AAC: такой формат без ПК вещать нельзя');
  return Mp4Info(video, audio);
}

List<_Box> _children(Uint8List bytes, int from, int to) {
  final out = <_Box>[];
  final data = ByteData.sublistView(bytes);
  var position = from;
  while (position + 8 <= to) {
    var size = data.getUint32(position);
    final type = String.fromCharCodes(bytes.sublist(position + 4, position + 8));
    var headerLength = 8;
    if (size == 1 && position + 16 <= to) {
      size = data.getUint64(position + 8);
      headerLength = 16;
    } else if (size == 0) {
      size = to - position;
    }
    if (size < headerLength || position + size > to) break;
    out.add(_Box(type, position, position + size, headerLength));
    position += size;
  }
  return out;
}

_Box? _find(List<_Box> boxes, String type) {
  for (final box in boxes) {
    if (box.type == type) return box;
  }
  return null;
}

Mp4Track? _parseTrak(Uint8List b, _Box trak) {
  final mdia = _find(_children(b, trak.dataStart, trak.end), 'mdia');
  if (mdia == null) return null;
  final mediaBoxes = _children(b, mdia.dataStart, mdia.end);
  final mdhd = _find(mediaBoxes, 'mdhd'), hdlr = _find(mediaBoxes, 'hdlr'), minf = _find(mediaBoxes, 'minf');
  if (mdhd == null || hdlr == null || minf == null) return null;
  final data = ByteData.sublistView(b);
  final timescale = data.getUint32(mdhd.dataStart + (b[mdhd.dataStart] == 1 ? 20 : 12));
  final handler = String.fromCharCodes(b.sublist(hdlr.dataStart + 8, hdlr.dataStart + 12));
  if (handler != 'vide' && handler != 'soun') return null;
  final stbl = _find(_children(b, minf.dataStart, minf.end), 'stbl');
  if (stbl == null || timescale == 0) return null;
  final table = _children(b, stbl.dataStart, stbl.end);
  final stsd = _find(table, 'stsd');
  if (stsd == null) return null;

  // Описание кодека.
  final entry = _children(b, stsd.dataStart + 8, stsd.end);
  if (entry.isEmpty) return null;
  final codec = entry.first;
  Uint8List? asc;
  var sampleRate = 0, channels = 0;
  List<Uint8List> sps = [], pps = [];
  var nalLength = 4;
  final isVideo = handler == 'vide';
  if (isVideo) {
    if (codec.type != 'avc1' && codec.type != 'avc3') throw Mp4Unsupported('Видео не H.264 (${codec.type.trim()}): такой формат без ПК вещать нельзя');
    final avcC = _find(_children(b, codec.start + 8 + 78, codec.end), 'avcC');
    if (avcC == null) throw Mp4Unsupported('В файле нет параметров H.264');
    var p = avcC.dataStart + 4;
    nalLength = (b[p] & 3) + 1;
    p++;
    final spsCount = b[p] & 31;
    p++;
    for (var i = 0; i < spsCount; i++) {
      final n = data.getUint16(p);
      sps.add(Uint8List.sublistView(b, p + 2, p + 2 + n));
      p += 2 + n;
    }
    final ppsCount = b[p];
    p++;
    for (var i = 0; i < ppsCount; i++) {
      final n = data.getUint16(p);
      pps.add(Uint8List.sublistView(b, p + 2, p + 2 + n));
      p += 2 + n;
    }
    if (sps.isEmpty || pps.isEmpty) throw Mp4Unsupported('В файле нет параметров H.264');
  } else {
    if (codec.type != 'mp4a') throw Mp4Unsupported('Звук не AAC (${codec.type.trim()}): такой формат без ПК вещать нельзя');
    final esds = _find(_children(b, codec.start + 8 + 28, codec.end), 'esds');
    if (esds == null) throw Mp4Unsupported('В файле нет параметров AAC');
    asc = _audioSpecificConfig(b, esds.dataStart + 4, esds.end);
    final parsed = parseAudioSpecificConfig(asc);
    sampleRate = parsed.$1;
    channels = parsed.$2;
  }

  // Таблицы кадров.
  List<(int, int)> pairs(String type, int fieldSize) {
    final box = _find(table, type);
    if (box == null) return const [];
    final count = data.getUint32(box.dataStart + 4);
    return [for (var i = 0; i < count; i++) (data.getUint32(box.dataStart + 8 + i * fieldSize), data.getInt32(box.dataStart + 12 + i * fieldSize))];
  }

  final stts = pairs('stts', 8);
  final cttsBox = _find(table, 'ctts');
  final ctts = cttsBox == null ? const <(int, int)>[] : pairs('ctts', 8);
  final stsz = _find(table, 'stsz');
  if (stsz == null) return null;
  final fixedSize = data.getUint32(stsz.dataStart + 4);
  final sampleCount = data.getUint32(stsz.dataStart + 8);
  final sizes = [for (var i = 0; i < sampleCount; i++) fixedSize != 0 ? fixedSize : data.getUint32(stsz.dataStart + 12 + i * 4)];

  final stsc = _find(table, 'stsc');
  final stco = _find(table, 'stco'), co64 = _find(table, 'co64');
  if (stsc == null || (stco == null && co64 == null)) return null;
  final chunkTotal = data.getUint32((stco ?? co64)!.dataStart + 4);
  int chunkOffset(int i) => stco != null ? data.getUint32(stco.dataStart + 8 + i * 4) : data.getUint64(co64!.dataStart + 8 + i * 8);
  final stscCount = data.getUint32(stsc.dataStart + 4);
  final runs = [for (var i = 0; i < stscCount; i++) (data.getUint32(stsc.dataStart + 8 + i * 12), data.getUint32(stsc.dataStart + 12 + i * 12))];

  final offsets = List<int>.filled(sampleCount, 0);
  var sample = 0;
  for (var chunk = 0; chunk < chunkTotal && sample < sampleCount; chunk++) {
    var perChunk = runs.first.$2;
    for (final run in runs) {
      if (run.$1 <= chunk + 1) perChunk = run.$2;
    }
    var at = chunkOffset(chunk);
    for (var k = 0; k < perChunk && sample < sampleCount; k++) {
      offsets[sample] = at;
      at += sizes[sample];
      sample++;
    }
  }

  final syncBox = _find(table, 'stss');
  final syncSet = <int>{};
  if (syncBox != null) {
    final count = data.getUint32(syncBox.dataStart + 4);
    for (var i = 0; i < count; i++) {
      syncSet.add(data.getUint32(syncBox.dataStart + 8 + i * 4) - 1);
    }
  }

  final samples = <Mp4Sample>[];
  var dts = 0, sttsIndex = 0, sttsLeft = stts.isEmpty ? 0 : stts.first.$1;
  var cttsIndex = 0, cttsLeft = ctts.isEmpty ? 0 : ctts.first.$1;
  for (var i = 0; i < sampleCount; i++) {
    while (sttsLeft == 0 && sttsIndex + 1 < stts.length) {
      sttsIndex++;
      sttsLeft = stts[sttsIndex].$1;
    }
    var offset = 0;
    if (ctts.isNotEmpty) {
      while (cttsLeft == 0 && cttsIndex + 1 < ctts.length) {
        cttsIndex++;
        cttsLeft = ctts[cttsIndex].$1;
      }
      offset = ctts[cttsIndex].$2;
      cttsLeft--;
    }
    samples.add(Mp4Sample(offsets[i], sizes[i], dts, dts + offset, syncBox == null || syncSet.contains(i)));
    dts += stts.isEmpty ? 0 : stts[sttsIndex].$2;
    sttsLeft--;
  }
  if (samples.isEmpty) return null;
  return Mp4Track(isVideo: isVideo, timescale: timescale, samples: samples, sps: sps, pps: pps, nalLength: nalLength, asc: asc, sampleRate: sampleRate, channels: channels);
}

// Дескрипторы esds: ES (0x03) → DecoderConfig (0x04) → DecoderSpecificInfo (0x05) = AudioSpecificConfig.
Uint8List _audioSpecificConfig(Uint8List b, int from, int to) {
  var p = from;
  int length() {
    var n = 0;
    for (var i = 0; i < 4; i++) {
      final byte = b[p++];
      n = (n << 7) | (byte & 0x7f);
      if (byte & 0x80 == 0) break;
    }
    return n;
  }

  while (p < to) {
    final tag = b[p++];
    final size = length();
    if (tag == 0x03) {
      p += 3; // ES_ID и флаги
    } else if (tag == 0x04) {
      if (b[p] != 0x40) throw Mp4Unsupported('Звук не AAC: такой формат без ПК вещать нельзя');
      p += 13;
    } else if (tag == 0x05) {
      return Uint8List.fromList(b.sublist(p, p + size));
    } else {
      p += size;
    }
  }
  throw Mp4Unsupported('В файле нет параметров AAC');
}

const _rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/// (частота, число каналов) из AudioSpecificConfig.
(int, int) parseAudioSpecificConfig(Uint8List asc) {
  if (asc.length < 2) throw Mp4Unsupported('Повреждены параметры AAC');
  var bits = 0, have = 0, p = 0;
  int read(int n) {
    while (have < n) {
      bits = (bits << 8) | (p < asc.length ? asc[p] : 0);
      p++;
      have += 8;
    }
    final value = (bits >> (have - n)) & ((1 << n) - 1);
    have -= n;
    bits &= (1 << have) - 1;
    return value;
  }

  var objectType = read(5);
  if (objectType == 31) objectType = 32 + read(6);
  var index = read(4);
  var rate = index == 15 ? read(24) : (index < _rates.length ? _rates[index] : 0);
  final channels = read(4);
  if (rate == 0) throw Mp4Unsupported('Повреждены параметры AAC');
  return (rate, channels);
}
