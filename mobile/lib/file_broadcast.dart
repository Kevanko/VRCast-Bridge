import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'byte_source.dart';
import 'links.dart';
import 'media_server.dart';
import 'mp4.dart';
import 'own_server.dart';
import 'rtp.dart';
import 'rtsp_session.dart';
import 'sinks.dart';

typedef RtspOpener = Future<RtspOut> Function(
  Uri url, {
  required String user,
  required String pass,
  required String sdp,
  required int tracks,
});

Future<RtspOut> _openRtsp(
  Uri url, {
  required String user,
  required String pass,
  required String sdp,
  required int tracks,
}) =>
    RtspSession.publish(url, user: user, pass: pass, sdp: sdp, tracks: tracks);

enum _Cmd { none, seek, next, previous, jump, stop }

const _channel = MethodChannel('vrcast/screen');

/// Включить или выключить службу переднего плана эфира (на других платформах и в проверках ничего не делает).
Future<void> holdAwake(bool on) async {
  try {
    await _channel.invokeMethod<void>(on ? 'broadcastStart' : 'broadcastStop');
  } catch (_) {}
}

/// Эфир файлов прямо с телефона на свой сервер, без ПК. Видео не перекодируется: кадры H.264/AAC из mp4 уходят на
/// сервер как есть, в реальном времени. Ссылка для зрителей — `rtspt://сервер:порт/phone`, та же, что у экрана телефона.
class FileBroadcast extends ChangeNotifier {
  FileBroadcast({
    RtspOpener? opener,
    this.speedUp = 1,
    this.hold = holdAwake,
    LinkResolver? resolver,
  }) : _open = opener ?? _openRtsp,
       _resolver = resolver ?? DefaultLinkResolver();

  final RtspOpener _open;
  final LinkResolver _resolver;

  /// Держит приложение живым, пока идёт эфир (служба переднего плана на Android). В проверках отключается.
  final Future<void> Function(bool on)? hold;
  final double speedUp; // для проверок: время идёт быстрее

  bool active = false;
  bool paused = false;
  bool connecting = false;
  List<SharedFile> playlist = const [];
  int index = 0;
  double position = 0;
  double duration = 0;
  String loopMode = 'once'; // once | one | all
  String? error;
  String? warning; // файл пропущен — вещание продолжается
  OwnServer? server;
  String _link = '';
  Future<Sink> Function(Mp4Info info)? _sinkFor;

  SharedFile? get current =>
      active && index >= 0 && index < playlist.length ? playlist[index] : null;

  /// Ссылка для зрителей (появляется, когда эфир запущен).
  String get viewLink => _link;

  int _run = 0;
  _Cmd _cmd = _Cmd.none;
  double _cmdValue = 0;
  int _cmdIndex = 0;
  double _timeline = 0; // время потока: метки RTP не должны идти назад при смене файла и перемотке
  Timer? _ticker;

  bool _disposed = false;

  void _changed() {
    // После dispose цикл эфира ещё может доработать последний шаг: слушателей уже нет, и сообщать некому.
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _run++; // цикл эфира увидит смену поколения и остановится
    _ticker?.cancel();
    super.dispose();
  }

  /// Эфир на свой сервер по RTSP.
  Future<void> start(OwnServer target, List<SharedFile> files, {int from = 0}) {
    server = target;
    return _begin(files, from, target.viewLink, null);
  }

  /// Эфир в HLS (бесплатная ссылка): готовый приёмник кадров и ссылка, по которой его смотрят.
  Future<void> startSink(
    Sink sink,
    String link,
    List<SharedFile> files, {
    int from = 0,
  }) {
    server = null;
    return _begin(files, from, link, (_) async => sink);
  }

  Future<void> _begin(
    List<SharedFile> files,
    int from,
    String link,
    Future<Sink> Function(Mp4Info info)? sinkFor,
  ) async {
    if (files.isEmpty) throw StateError('Нет файлов для эфира');
    await stop();
    _link = link;
    _sinkFor = sinkFor;
    playlist = List.of(files);
    index = from.clamp(0, files.length - 1);
    position = 0;
    duration = 0;
    error = null;
    warning = null;
    paused = false;
    active = true;
    connecting = true;
    _cmd = _Cmd.none;
    _timeline = 0;
    final run = ++_run;
    _ticker?.cancel();
    _ticker = Timer.periodic(const Duration(milliseconds: 500), (_) {
      if (active && !paused) _changed();
    });
    unawaited(hold?.call(true));
    _changed();
    unawaited(_loop(run));
  }

  Future<void> stop() async {
    if (!active && _run == 0) return;
    _cmd = _Cmd.stop;
    _run++;
    active = false;
    paused = false;
    connecting = false;
    _ticker?.cancel();
    unawaited(hold?.call(false));
    _changed();
  }

  void pause() {
    if (!active || paused) return;
    paused = true;
    _changed();
  }

  void resume() {
    if (!active || !paused) return;
    paused = false;
    _changed();
  }

  /// Остановить эфир с причиной (например, пропала ссылка).
  void fail(String message) {
    stop();
    error = message;
    _changed();
  }

  void seek(double seconds) => _command(_Cmd.seek, value: seconds);
  void next() => _command(_Cmd.next);
  void previous() => _command(_Cmd.previous);
  void jump(String id) {
    final i = playlist.indexWhere((f) => f.id == id);
    if (i >= 0) _command(_Cmd.jump, at: i);
  }

  void setLoop(String mode) {
    loopMode = const ['once', 'one', 'all'].contains(mode) ? mode : 'once';
    _changed();
  }

  void _command(_Cmd cmd, {double value = 0, int at = 0}) {
    if (!active) return;
    _cmd = cmd;
    _cmdValue = value;
    _cmdIndex = at;
    paused = false;
    _changed();
  }

  bool _alive(int run) => run == _run && active;

  Future<void> _loop(int run) async {
    Sink? pub;
    final skipped = <String>{};
    var startAt = 0.0;
    var reconnects = 0;
    try {
      while (_alive(run)) {
        final file = playlist[index];
        Mp4Info info;
        ByteSource source;
        try {
          source = file.isLink
              ? await _resolver.open(file)
              : FileSource(file.path);
          try {
            info = await readMp4From(source);
          } catch (_) {
            await source.close();
            rethrow;
          }
        } catch (e) {
          warning =
              '${file.title}: ${e is Mp4Unsupported || e is UnsupportedLink
                  ? e.toString()
                  : file.isLink
                  ? 'ссылка не открылась'
                  : 'файл не открылся'}';
          skipped.add(file.id);
          if (skipped.length >= playlist.length) {
            error = warning;
            _finishRun(run);
            return;
          }
          _step(1);
          startAt = 0;
          _changed();
          continue;
        }
        skipped.remove(file.id);
        duration = info.duration;
        if (pub == null || pub.closed || !pub.compatible(info)) {
          await pub?.close();
          connecting = true;
          _changed();
          try {
            pub = await _connect(info);
          } catch (e) {
            if (!_alive(run)) return;
            if (++reconnects > 3) {
              error = '$e';
              _finishRun(run);
              return;
            }
            await Future<void>.delayed(const Duration(seconds: 2));
            continue;
          }
          reconnects = 0;
        }
        connecting = false;
        _changed();
        final _Result result;
        try {
          result = await _playItem(run, pub, info, startAt, source);
        } finally {
          await source.close();
        }
        if (!_alive(run)) return;
        startAt = 0;
        switch (result) {
          case _Result.lost:
            debugPrint('эфир: соединение с сервером потеряно, переподключаюсь (попытка ${reconnects + 1})');
            if (++reconnects > 3) {
              error = 'Связь с сервером потеряна';
              _finishRun(run);
              return;
            }
            startAt = position;
            await pub.close();
            pub = null;
          case _Result.finished:
            if (!_advance()) {
              _finishRun(run);
              return;
            }
          case _Result.command:
            final cmd = _cmd;
            _cmd = _Cmd.none;
            switch (cmd) {
              case _Cmd.seek:
                startAt = _cmdValue < 0 ? 0 : _cmdValue;
              case _Cmd.next:
                if (!_advance(force: true)) {
                  _finishRun(run);
                  return;
                }
              case _Cmd.previous:
                if (position > 3) {
                  startAt = 0;
                } else {
                  _step(-1);
                }
              case _Cmd.jump:
                index = _cmdIndex;
              default:
                break;
            }
        }
        _changed();
      }
    } finally {
      await pub?.close();
    }
  }

  void _finishRun(int run) {
    if (run != _run) return;
    active = false;
    paused = false;
    connecting = false;
    position = 0;
    duration = 0;
    _ticker?.cancel();
    unawaited(hold?.call(false));
    _changed();
  }

  void _step(int by) {
    index = (index + by) % playlist.length;
    if (index < 0) index += playlist.length;
  }

  /// Дальше по режиму повтора. false — очередь закончилась.
  bool _advance({bool force = false}) {
    if (loopMode == 'one' && !force) return true;
    if (index + 1 >= playlist.length) {
      if (loopMode == 'all' || (force && loopMode == 'one')) {
        index = 0;
        return true;
      }
      return false;
    }
    index++;
    return true;
  }

  Future<Sink> _connect(Mp4Info info) async {
    final custom = _sinkFor;
    if (custom != null) return custom(info);
    final target = server!;
    final url = Uri(
      scheme: 'rtsp',
      host: target.host,
      port: target.rtspPort,
      path: '/phone',
    );
    final out = await _open(
      url,
      user: 'vrcast',
      pass: target.key,
      sdp: buildSdp(video: info.video, audio: info.audio),
      tracks: (info.video != null ? 1 : 0) + (info.audio != null ? 1 : 0),
    );
    return RtspSink(out, info);
  }

  /// Чтение по сети бывает медленным (слабый интернет, долгое соединение): пока ждём, сервер должен слышать нас,
  /// иначе он закроет публикацию, и эфир оборвётся.
  Future<Uint8List> _readAlive(ByteSource source, Sink pub, int offset, int size) async {
    final reading = source.read(offset, size);
    var ticks = 0;
    final keep = Timer.periodic(const Duration(seconds: 2), (_) {
      pub.report(DateTime.now());
      unawaited(pub.flush());
      // Отчётов серверу мало: он считает связь живой по запросам RTSP, поэтому раз в 4 секунды ещё и пинг.
      if (++ticks % 2 == 0) unawaited(pub.keepAlive());
    });
    try {
      return await reading;
    } finally {
      keep.cancel();
    }
  }

  Future<_Result> _playItem(
    int run,
    Sink pub,
    Mp4Info info,
    double startAt,
    ByteSource source,
  ) async {
    final video = info.video, audio = info.audio;
    var vi = 0;
    if (video != null) {
      for (var i = 0; i < video.samples.length; i++) {
        if (video.samples[i].sync &&
            video.seconds(video.samples[i].dts) <= startAt)
          vi = i;
        if (video.seconds(video.samples[i].dts) > startAt) break;
      }
    }
    final segStart = video != null
        ? video.seconds(video.samples[vi].dts)
        : startAt;
    var ai = 0;
    if (audio != null) {
      while (ai < audio.samples.length &&
          audio.seconds(audio.samples[ai].dts) < segStart) {
        ai++;
      }
    }
    final segBase = _timeline + 0.04;
    pub.begin(info);
    var anchor = DateTime.now();
    var lastReport = anchor;
    var lastKeepAlive = anchor;
    while (true) {
      final vTime = video != null && vi < video.samples.length
          ? video.seconds(video.samples[vi].dts)
          : double.infinity;
      final aTime = audio != null && ai < audio.samples.length
          ? audio.seconds(audio.samples[ai].dts)
          : double.infinity;
      if (vTime == double.infinity && aTime == double.infinity) {
        _timeline = segBase + (info.duration - segStart);
        return _Result.finished;
      }
      final isVideo = vTime <= aTime;
      final t = isVideo ? vTime : aTime;
      // Ждём своего времени; на паузе держим соединение живым.
      while (true) {
        if (!_alive(run)) return _Result.command;
        if (_cmd != _Cmd.none) return _Result.command;
        if (pub.closed) return _Result.lost;
        final now = DateTime.now();
        if (paused) {
          // Пауза или долгое ожидание данных: сервер закрывает публикацию, если от неё 10 с ничего нет. Шлём отчёты и пинг.
          if (now.difference(lastReport).inSeconds >= 2) {
            lastReport = now;
            pub.report(now);
            await pub.flush();
          }
          if (now.difference(lastKeepAlive).inSeconds >= 4) {
            lastKeepAlive = now;
            await pub.keepAlive();
          }
          await Future<void>.delayed(const Duration(milliseconds: 100));
          anchor = anchor.add(const Duration(milliseconds: 100));
          continue;
        }
        final due = anchor.add(
          Duration(microseconds: ((t - segStart) * 1000000 / speedUp).round()),
        );
        final wait = due.difference(now);
        if (wait <= Duration.zero) {
          // Отстали больше чем на секунду (медленная сеть): не пытаемся нагнать пачкой.
          if (-wait > const Duration(seconds: 1)) anchor = anchor.add(-wait);
          break;
        }
        await Future<void>.delayed(
          wait > const Duration(milliseconds: 100)
              ? const Duration(milliseconds: 100)
              : wait,
        );
      }
      final track = isVideo ? video! : audio!;
      final sample = track.samples[isVideo ? vi : ai];
      final Uint8List data;
      try {
        data = await _readAlive(source, pub, sample.offset, sample.size);
      } catch (_) {
        warning = '${playlist[index].title}: поток оборвался';
        _timeline = segBase + (t - segStart);
        return _Result.finished;
      }
      if (data.length < sample.size) {
        // Файл оборвался или удалён во время эфира.
        warning = '${playlist[index].title}: файл недоступен';
        _timeline = segBase + (t - segStart);
        return _Result.finished;
      }
      if (isVideo) {
        pub.video(
          video!,
          data,
          pts: segBase + (track.seconds(sample.cts) - segStart),
          dts: segBase + (t - segStart),
          sync: sample.sync,
        );
        vi++;
      } else {
        pub.audio(audio!, data, pts: segBase + (t - segStart));
        ai++;
      }
      _timeline = segBase + (t - segStart);
      position = t;
      final now = DateTime.now();
      if (now.difference(lastReport).inMilliseconds >= 2000) {
        lastReport = now;
        pub.report(now);
      }
      await pub.flush();
    }
  }
}

enum _Result { finished, command, lost }
