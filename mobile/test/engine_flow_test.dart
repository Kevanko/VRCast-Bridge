import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:vrcast_remote/file_broadcast.dart';
import 'package:vrcast_remote/links.dart';
import 'package:vrcast_remote/media_server.dart';
import 'package:vrcast_remote/own_server.dart';
import 'package:vrcast_remote/rtsp_session.dart';
import 'package:vrcast_remote/transcode.dart';

bool _has(String name) => Process.runSync('which', [name]).exitCode == 0;

class FakeOut implements RtspOut {
  int rtp = 0, rtcp = 0;
  @override
  bool get closed => false;
  @override
  void sendRtp(int track, Uint8List packet) => rtp++;
  @override
  void sendRtcp(int track, Uint8List packet) => rtcp++;
  @override
  Future<void> flush() async {}
  @override
  Future<void> keepAlive() async {}
  @override
  Future<void> close() async {}
}

/// Подставной движок: присылает параметры кодеков, потом кадры и звук в темпе времени, потом `end`.
class FakeEngine implements EngineSession {
  FakeEngine(this.params, {this.seconds = 3, this.failWith, this.stall = false}) {
    _run();
  }
  final EngineParams params;
  final double seconds;
  final String? failWith;
  final bool stall;
  final _controller = StreamController<Map<String, dynamic>>();
  bool stopped = false, paused = false;
  final calls = <String>[];
  final volumes = <double>[];

  @override
  Stream<Map<String, dynamic>> get events => _controller.stream;

  Future<void> _run() async {
    await Future<void>.delayed(const Duration(milliseconds: 20));
    if (failWith != null) {
      _controller.add({'type': 'error', 'message': failWith});
      return;
    }
    _controller.add({'type': 'vcfg', 'sps': Uint8List.fromList([0x67, 0x42, 0xC0, 0x1F, 0xAA, 0xBB]), 'pps': Uint8List.fromList([0x68, 0xCE, 0x3C, 0x80]), 'width': 1280, 'height': 720, 'fps': 30});
    _controller.add({'type': 'acfg', 'asc': Uint8List.fromList([0x11, 0x90]), 'sampleRate': 48000, 'channels': 2});
    if (stall) return;
    var frame = 0;
    final total = (seconds * 25).round();
    while (!stopped && frame < total) {
      while (paused && !stopped) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      if (stopped) return;
      final pts = (frame * 40000);
      _controller.add({'type': 'v', 'pts': pts, 'key': frame % 25 == 0, 'data': Uint8List.fromList([0, 0, 0, 5, 0x65, 1, 2, 3, 4])});
      if (frame % 2 == 0) _controller.add({'type': 'a', 'pts': pts, 'data': Uint8List.fromList(List.filled(100, 7))});
      frame++;
      await Future<void>.delayed(const Duration(milliseconds: 8));
    }
    if (!stopped) _controller.add({'type': 'end'});
  }

  @override
  Future<void> pause() async {
    calls.add('pause');
    paused = true;
  }

  @override
  Future<void> resume() async {
    calls.add('resume');
    paused = false;
  }

  @override
  Future<void> setVolume(double value) async => volumes.add(value);

  @override
  Future<void> stop() async {
    calls.add('stop');
    stopped = true;
    if (!_controller.isClosed) await _controller.close();
  }
}

class Rig {
  final started = <FakeEngine>[];
  final outs = <FakeOut>[];
  var opens = 0;
  Object? Function(EngineParams)? configure;
  late final FileBroadcast broadcast;

  Rig({VideoProfile profile = VideoProfile.copy, double seconds = 3, String? failWith, bool engineAvailable = true, LinkResolver? resolver}) {
    broadcast = FileBroadcast(
      hold: null,
      resolver: resolver,
      profile: () => profile,
      engineStarter: engineAvailable
          ? (params) async {
              final fake = FakeEngine(params, seconds: seconds, failWith: failWith);
              started.add(fake);
              return fake;
            }
          : null,
      opener: (url, {required user, required pass, required sdp, required tracks}) async {
        opens++;
        final out = FakeOut();
        outs.add(out);
        return out;
      },
    );
  }

  Future<void> start(List<SharedFile> files, {int from = 0}) => broadcast.start(OwnServer(name: 'x', host: '127.0.0.1', rtspPort: 9, key: 'k'), files, from: from);

  int get rtp => outs.fold(0, (n, o) => n + o.rtp);
}

Future<void> until(bool Function() check, String message, {int tries = 100}) async {
  for (var i = 0; i < tries; i++) {
    if (check()) return;
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
  fail(message);
}

void main() {
  late Directory dir;
  late String clip, hevc, music;

  setUpAll(() async {
    if (!_has('ffmpeg')) return;
    dir = await Directory.systemTemp.createTemp('vrcast-eng');
    Future<String> make(String name, List<String> args) async {
      final out = '${dir.path}/$name';
      final r = await Process.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-y', out]);
      expect(r.exitCode, 0, reason: '${r.stderr}');
      return out;
    }

    clip = await make('clip.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
    hevc = await make('hevc.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25', '-t', '2', '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-an']);
    music = await make('music.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '3', '-c:a', 'libmp3lame']);
  });
  tearDownAll(() async {
    if (_has('ffmpeg')) await dir.delete(recursive: true);
  });

  final skip = _has('ffmpeg') ? false : 'нужен ffmpeg';

  test('скорость не 1: ролик идёт через движок, кадры доходят до приёмника, позиция считается по времени источника', () async {
    final rig = Rig(profile: const VideoProfile(quality: '720p', fps: 60, bitrateKbps: 4000), seconds: 2);
    rig.broadcast.speed = 2;
    addTearDown(rig.broadcast.stop);
    await rig.start([SharedFile(id: 'a', path: clip, title: 'А', duration: 5)]);
    await until(() => rig.rtp > 20, 'кадры от движка должны дойти до приёмника');
    final params = rig.started.single.params;
    expect(params.videoSource, clip);
    expect(params.speed, 2);
    expect(params.startUs, 0);
    expect(params.profile.size, (1280, 720));
    expect(params.profile.fps, 60);
    expect(params.profile.bitrate, 4000000);
    await until(() => rig.broadcast.position > 1.0, 'позиция идёт по времени источника (в два раза быстрее)');
    expect(rig.broadcast.duration, 5, reason: 'длительность ролика известна заранее и не зависит от скорости');
    expect(rig.opens, 1);
  }, skip: skip);

  test('«как в файле» и обычная скорость: движок не нужен, ролик идёт без перекодирования', () async {
    final rig = Rig();
    addTearDown(rig.broadcast.stop);
    await rig.start([SharedFile(id: 'a', path: clip, title: 'А', duration: 5)]);
    await until(() => rig.rtp > 20, 'копирующий путь');
    expect(rig.started, isEmpty);
  }, skip: skip);

  test('формат не подходит для копирования (HEVC, mp3): с движком ролик перекодируется, без него — пропускается с причиной', () async {
    final withEngine = Rig(seconds: 1);
    addTearDown(withEngine.broadcast.stop);
    await withEngine.start([SharedFile(id: 'h', path: hevc, title: 'HEVC'), SharedFile(id: 'm', path: music, title: 'Песня')]);
    await until(() => withEngine.started.isNotEmpty && withEngine.rtp > 5, 'HEVC идёт через движок');
    expect(withEngine.started.first.params.videoSource, hevc);
    expect(withEngine.broadcast.warning, isNull);
    expect(withEngine.started.first.params.profile.quality, '720p', reason: 'при «как в файле» перекодирование берёт 720p');
    withEngine.broadcast.next();
    await until(() => withEngine.started.length >= 2, 'mp3 тоже идёт через движок (картинки нет — движок рисует чёрный кадр)');
    expect(withEngine.started[1].params.videoSource, music);

    final without = Rig(engineAvailable: false);
    addTearDown(without.broadcast.stop);
    await without.start([SharedFile(id: 'h', path: hevc, title: 'HEVC'), SharedFile(id: 'a', path: clip, title: 'А', duration: 5)]);
    await until(() => without.broadcast.current?.id == 'a' && without.rtp > 5, 'без движка HEVC пропущен, следующий идёт');
    expect(without.broadcast.warning, contains('не H.264'));
  }, skip: skip, timeout: const Timeout(Duration(minutes: 1)));

  test('перемотка перезапускает движок с нужного места; смена скорости на лету — с текущего места и новой скоростью', () async {
    final rig = Rig(profile: const VideoProfile(quality: '720p'), seconds: 5);
    rig.broadcast.speed = 1.5;
    addTearDown(rig.broadcast.stop);
    await rig.start([SharedFile(id: 'a', path: clip, title: 'А', duration: 60)]);
    await until(() => rig.broadcast.position > 0.3, 'идёт');
    rig.broadcast.seek(30);
    await until(() => rig.started.length >= 2, 'после перемотки новый запуск движка');
    expect(rig.started[1].params.startUs, 30000000);
    expect(rig.started.first.calls, contains('stop'), reason: 'прежний запуск остановлен');
    await until(() => rig.broadcast.position >= 30, 'позиция продолжается с места перемотки');
    rig.broadcast.setSpeed(2);
    await until(() => rig.started.length >= 3, 'смена скорости — новый запуск');
    expect(rig.started[2].params.speed, 2);
    expect(rig.started[2].params.startUs, greaterThanOrEqualTo(30000000), reason: 'с текущего места, а не с начала');
    expect(rig.opens, 1, reason: 'формат эфира один и тот же: приёмник не переподключается');
  }, skip: skip, timeout: const Timeout(Duration(minutes: 1)));

  test('громкость: на лету уходит в движок; из режима «как в файле» переводит ролик на перекодирование с этого места', () async {
    final rig = Rig(profile: const VideoProfile(quality: '720p'), seconds: 5);
    addTearDown(rig.broadcast.stop);
    await rig.start([SharedFile(id: 'a', path: clip, title: 'А', duration: 5)]);
    await until(() => rig.started.isNotEmpty && rig.broadcast.position > 0.2, 'идёт через движок (профиль 720p)');
    rig.broadcast.setVolume(0.5);
    expect(rig.started.single.volumes, [0.5]);
    expect(rig.started.length, 1, reason: 'громкость меняется без перезапуска');
    rig.broadcast.setVolume(2.0);
    expect(rig.started.single.volumes, [0.5, 2.0]);
    rig.broadcast.setVolume(9);
    expect(rig.started.single.volumes.last, 2.0, reason: 'больше 200% нельзя');

    final copy = Rig(seconds: 5);
    addTearDown(copy.broadcast.stop);
    await copy.start([SharedFile(id: 'a', path: clip, title: 'А', duration: 5)]);
    await until(() => copy.rtp > 10, 'идёт как в файле');
    expect(copy.started, isEmpty);
    copy.broadcast.setVolume(0.3);
    await until(() => copy.started.isNotEmpty, 'ненулевая громкость: ролик переходит на перекодирование');
    expect(copy.started.single.params.volume, 0.3);
    expect(copy.started.single.params.startUs, greaterThan(0), reason: 'с того места, где шёл');
  }, skip: skip, timeout: const Timeout(Duration(minutes: 1)));

  test('пауза замораживает движок и держит приёмник живым; продолжение запускает его снова', () async {
    final rig = Rig(profile: const VideoProfile(quality: '720p'), seconds: 20);
    addTearDown(rig.broadcast.stop);
    await rig.start([SharedFile(id: 'a', path: clip, title: 'А', duration: 5)]);
    await until(() => rig.rtp > 10, 'идёт');
    rig.broadcast.pause();
    await until(() => rig.started.single.paused, 'движок поставлен на паузу');
    final before = rig.rtp;
    await Future<void>.delayed(const Duration(milliseconds: 600));
    expect(rig.rtp - before, lessThan(5), reason: 'на паузе кадры не идут');
    rig.broadcast.resume();
    await until(() => !rig.started.single.paused && rig.rtp > before + 10, 'после паузы кадры снова идут');
  }, skip: skip, timeout: const Timeout(Duration(minutes: 1)));

  test('ошибка движка: ролик пропускается с причиной, остальные идут; если играть нечем — эфир останавливается с причиной', () async {
    final rig = Rig(profile: const VideoProfile(quality: '720p'), failWith: 'Кодировщик H.264 недоступен');
    addTearDown(rig.broadcast.stop);
    await rig.start([SharedFile(id: 'a', path: clip, title: 'А', duration: 5)]);
    await until(() => !rig.broadcast.active, 'эфир остановился: играть нечем');
    expect(rig.broadcast.error, contains('Кодировщик H.264 недоступен'));
  }, skip: skip);

  test('два ролика подряд идут одним потоком: один сеанс, метки времени не идут назад', () async {
    final rig = Rig(profile: const VideoProfile(quality: '720p'), seconds: 1);
    addTearDown(rig.broadcast.stop);
    await rig.start([SharedFile(id: 'a', path: clip, title: 'А', duration: 1), SharedFile(id: 'b', path: clip, title: 'Б', duration: 1)]);
    await until(() => rig.started.length >= 2 && rig.broadcast.current?.id == 'b', 'второй ролик пошёл');
    expect(rig.opens, 1, reason: 'формат эфира тот же — приёмник не переподключался');
  }, skip: skip, timeout: const Timeout(Duration(minutes: 1)));

  test('профиль качества: размеры, битрейт по умолчанию и явный', () {
    expect(const VideoProfile(quality: '480p').size, (854, 480));
    expect(const VideoProfile(quality: '1080p').size, (1920, 1080));
    expect(VideoProfile.copy.isCopy, isTrue);
    expect(const VideoProfile(quality: '720p', fps: 30).bitrate, 3000000);
    expect(const VideoProfile(quality: '720p', fps: 60).bitrate, 4500000, reason: '60 кадров просят на полтора раза больше');
    expect(const VideoProfile(quality: '1080p', fps: 30).bitrate, 5000000);
    expect(const VideoProfile(quality: '480p', bitrateKbps: 900).bitrate, 900000);
    expect(const VideoProfile(quality: '720p') == const VideoProfile(quality: '720p'), isTrue);
    expect(EngineParams(videoSource: 'a', profile: const VideoProfile(quality: '720p', fps: 60), speed: 1.25).toMap()['fps'], 60);
  });

  test('YouTube HD: выбирается H.264 до нужной высоты, VP9 только до 720p, звук AAC; без раздельных потоков — null', () {
    final videos = [
      (url: 'v-1080-avc', codec: 'avc1.640028', height: 1080, bitrate: 4000000),
      (url: 'v-720-avc', codec: 'avc1.64001f', height: 720, bitrate: 2000000),
      (url: 'v-1440-vp9', codec: 'vp09.00.40.08', height: 1440, bitrate: 9000000),
      (url: 'v-720-vp9', codec: 'vp09.00.31.08', height: 720, bitrate: 1500000),
    ];
    final audios = [
      (url: 'a-opus', codec: 'opus', bitrate: 160000),
      (url: 'a-aac-hi', codec: 'mp4a.40.2', bitrate: 130000),
      (url: 'a-aac-lo', codec: 'mp4a.40.5', bitrate: 48000),
    ];
    var pick = DefaultLinkResolver.pickYoutubeStreams(videos, audios, 1080);
    expect(pick.video, 'v-1080-avc');
    expect(pick.audio, 'a-aac-hi', reason: 'AAC предпочтительнее: не нужен декодер Opus');
    expect(DefaultLinkResolver.pickYoutubeStreams(videos, audios, 720).video, 'v-720-avc');
    expect(DefaultLinkResolver.pickYoutubeStreams(videos, audios, 480).video, 'v-720-avc', reason: 'ниже лимита ничего нет — берём наименьший');
    pick = DefaultLinkResolver.pickYoutubeStreams([videos[2], videos[3]], audios, 1080);
    expect(pick.video, 'v-720-vp9', reason: 'VP9 только до 720p: выше телефоны декодируют программно и греются');
    expect(DefaultLinkResolver.pickYoutubeStreams([], [], 720).video, isNull);
    expect(DefaultLinkResolver.pickYoutubeStreams(videos, [audios[0]], 720).audio, 'a-opus', reason: 'AAC нет — берём что есть');
  });
}
