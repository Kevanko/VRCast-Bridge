import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;

import 'own_server.dart';

/// Параметры отправки экрана под профиль эфира ПК: во сколько раз уменьшить картинку,
/// какой битрейт и сколько кадров в секунду. ПК всё равно кодирует эфир в свой профиль
/// (высота 480/720/1080), поэтому отправлять с телефона больше нет смысла.
({double scale, int bitrate, int fps}) phoneEncoding({required String quality, required int fps, required int bitrateKbps, required int width, required int height}) {
  final target = {'480p': 480, '720p': 720, '1080p': 1080}[quality] ?? 720;
  final longSide = (width > height ? width : height).clamp(1, 1 << 14);
  final scale = longSide <= target ? 1.0 : longSide / target;
  final fallback = {'480p': 1500000, '720p': 3000000, '1080p': 5000000}[quality] ?? 3000000;
  // Канал до ПК — домашняя сеть: битрейт эфира берём с запасом, но в разумных пределах.
  final bitrate = bitrateKbps > 0 ? (bitrateKbps * 1000).clamp(800000, 8000000) : fallback;
  return (scale: scale, bitrate: bitrate, fps: fps >= 60 ? 60 : 30);
}

/// Из списка кодеков телефона оставляет H.264 (его читает плеер VRChat); пусто, если телефон так не умеет.
List<RTCRtpCodecCapability> h264Codecs(List<RTCRtpCodecCapability> all) => all.where((c) => c.mimeType.toLowerCase() == 'video/h264').toList();

/// Битрейт отправки напрямую на свой сервер: по интернету экономнее, чем по домашней сети.
int directBitrateKbps(String quality) => {'480p': 1200, '720p': 2500, '1080p': 4000}[quality] ?? 2500;

/// Передаёт экран телефона на ПК или на свой сервер: запись экрана → WebRTC → WHIP в MediaMTX на ПК.
class PhoneStream {
  static const _native = MethodChannel('vrcast/screen');

  RTCPeerConnection? _pc;
  RTCRtpSender? _sender;
  Timer? _keyframes;
  MediaStream? _stream;
  Uri? _resource; // адрес сессии WHIP, по нему её закрывают
  Map<String, String> _auth = const {};
  bool live = false;
  DateTime? startedAt;
  String _profileKey = '';
  String lastApplied = ''; // для диагностики и тестов
  String selectedCodec = ''; // что выбрано для отправки: «H.264» или «нет H.264» (тогда кодек по умолчанию)
  bool get lacksH264 => selectedCodec == 'нет H.264';
  final _changes = StreamController<void>.broadcast();
  Stream<void> get changes => _changes.stream;

  /// Сообщить подписчикам, что состояние изменилось (нужно заглушкам в тестах).
  @visibleForTesting
  void emitChange() => _changes.add(null);

  /// Экран телефона → ПК. [pc] — адрес ПК (http://хост:порт), [webrtcPort] — порт WebRTC на нём.
  Future<void> start(Uri pc, int webrtcPort, {String quality = '720p', int fps = 30, int bitrateKbps = 0}) =>
      _publish(pc.replace(port: webrtcPort, path: '/phone/whip'), const {},
          quality: quality, fps: fps, bitrateKbps: bitrateKbps, h264: false, hint: 'Устройство не приняло поток. Включён ли «Доступ с других устройств»?');

  /// Экран телефона → свой сервер напрямую, без ПК. Видео H.264: его понимает плеер в VRChat.
  Future<void> startDirect(OwnServer server, {String quality = '720p', int fps = 30}) =>
      _publish(server.whip, {'Authorization': server.basicAuth},
          quality: quality, fps: fps, bitrateKbps: directBitrateKbps(quality), h264: true,
          hint: 'Сервер не принял поток. Он должен быть обновлён («Настроить с нуля» в программе на ПК), а порты TCP ${server.rtspPort + 11} и UDP ${server.rtspPort + 12} открыты.');

  Future<void> _publish(Uri whip, Map<String, String> headers,
      {required String quality, required int fps, required int bitrateKbps, required bool h264, required String hint}) async {
    if (live) return;
    // Согласие на запись экрана берём заранее: службу переднего плана Android 14+
    // разрешает запускать только после него.
    if (!await Helper.requestCapturePermission()) throw 'Запись экрана не разрешена';
    await _native.invokeMethod('start');
    try {
      final stream = await navigator.mediaDevices.getDisplayMedia({'video': {'frameRate': 30}, 'audio': false});
      _stream = stream;
      final connection = await createPeerConnection({'iceServers': <Map<String, Object>>[], 'sdpSemantics': 'unified-plan'});
      _pc = connection;
      final transceiver = await connection.addTransceiver(
        track: stream.getVideoTracks().first,
        kind: RTCRtpMediaType.RTCRtpMediaTypeVideo,
        init: RTCRtpTransceiverInit(direction: TransceiverDirection.SendOnly, streams: [stream]),
      );
      _sender = transceiver.sender;
      if (h264) await _preferH264(transceiver);
      await applyProfile(quality: quality, fps: fps, bitrateKbps: bitrateKbps);

      final gathered = Completer<void>();
      connection.onIceGatheringState = (state) {
        if (state == RTCIceGatheringState.RTCIceGatheringStateComplete && !gathered.isCompleted) gathered.complete();
      };
      final offer = await connection.createOffer({'offerToReceiveVideo': false, 'offerToReceiveAudio': false});
      await connection.setLocalDescription(offer);
      await gathered.future.timeout(const Duration(seconds: 4), onTimeout: () {});
      final local = await connection.getLocalDescription();

      final http.Response response;
      try {
        response = await http.post(whip, headers: {'Content-Type': 'application/sdp', ...headers}, body: local!.sdp).timeout(const Duration(seconds: 10));
      } on TimeoutException {
        throw 'Нет ответа от ${whip.host}. $hint';
      }
      if (response.statusCode == 401) throw 'Сервер отклонил ключ. Проверьте ключ в настройках сервера.';
      if (response.statusCode != 201) throw '$hint (ответ ${response.statusCode})';
      final location = response.headers['location'];
      if (location != null) _resource = whip.resolve(location);
      _auth = headers;
      await connection.setRemoteDescription(RTCSessionDescription(response.body, 'answer'));
      connection.onConnectionState = (state) {
        if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed || state == RTCPeerConnectionState.RTCPeerConnectionStateClosed) stop();
      };
      stream.getVideoTracks().first.onEnded = stop;
      live = true;
      startedAt = DateTime.now();
      // Статичный экран кадров почти не даёт, а приёмник без них не может начать читать поток и
      // считает эфир зависшим. Подталкиваем кодек чаще секунды: кадры идут без пауз.
      _keyframes = Timer.periodic(const Duration(milliseconds: 600), (_) => _forceKeyframe());
      Timer(const Duration(milliseconds: 500), _forceKeyframe);
      _changes.add(null);
    } catch (e) {
      await stop();
      rethrow;
    }
  }

  /// Плеер VRChat (AVPro) читает только H.264. Если кодека нет, остаётся выбор по умолчанию.
  Future<void> _preferH264(RTCRtpTransceiver transceiver) async {
    try {
      final capabilities = await getRtpSenderCapabilities('video');
      final all = capabilities.codecs ?? const <RTCRtpCodecCapability>[];
      final h264 = h264Codecs(all);
      debugPrint('PhoneStream: кодеки телефона: ${all.map((c) => c.mimeType).toSet().join(', ')}');
      if (h264.isEmpty) {
        selectedCodec = 'нет H.264';
      } else {
        await transceiver.setCodecPreferences(h264);
        selectedCodec = 'H.264';
      }
    } catch (e) {
      debugPrint('PhoneStream: H.264 недоступен ($e), останется кодек по умолчанию');
    }
  }

  /// Подстраивает отправку под профиль эфира ПК; вызывается при старте и при смене настроек на ПК.
  Future<void> applyProfile({required String quality, required int fps, required int bitrateKbps}) async {
    final key = '$quality/$fps/$bitrateKbps';
    final sender = _sender;
    if (sender == null || key == _profileKey) return;
    _profileKey = key;
    var width = 1080, height = 2400;
    try {
      final settings = _stream?.getVideoTracks().first.getSettings();
      width = (settings?['width'] as num?)?.toInt() ?? width;
      height = (settings?['height'] as num?)?.toInt() ?? height;
    } catch (_) {}
    final plan = phoneEncoding(quality: quality, fps: fps, bitrateKbps: bitrateKbps, width: width, height: height);
    try {
      final parameters = sender.parameters;
      parameters.encodings = [RTCRtpEncoding(rid: null, active: true, maxBitrate: plan.bitrate, maxFramerate: plan.fps, scaleResolutionDownBy: plan.scale)];
      await sender.setParameters(parameters);
      lastApplied = 'scale=${plan.scale.toStringAsFixed(2)} bitrate=${plan.bitrate} fps=${plan.fps}';
      debugPrint('PhoneStream: профиль $key → $lastApplied');
    } catch (e) {
      _profileKey = '';
    }
  }

  /// Кратко выключаем и включаем отправку: после возобновления кодек выдаёт ключевой кадр.
  Future<void> _forceKeyframe() async {
    final sender = _sender;
    if (sender == null || !live && startedAt != null) return;
    try {
      final parameters = sender.parameters;
      final encodings = parameters.encodings;
      if (encodings == null || encodings.isEmpty) return;
      encodings[0].active = false;
      await sender.setParameters(parameters);
      await Future<void>.delayed(const Duration(milliseconds: 30));
      encodings[0].active = true;
      await sender.setParameters(parameters);
    } catch (_) {}
  }

  Future<void> stop() async {
    _keyframes?.cancel();
    _keyframes = null;
    _sender = null;
    _profileKey = '';
    final resource = _resource;
    final wasLive = live || _pc != null;
    live = false;
    _resource = null;
    if (resource != null) http.delete(resource, headers: _auth).timeout(const Duration(seconds: 3)).catchError((Object _) => http.Response('', 0));
    for (final track in _stream?.getTracks() ?? const <MediaStreamTrack>[]) {
      await track.stop();
    }
    await _stream?.dispose();
    _stream = null;
    await _pc?.close();
    _pc = null;
    try { await _native.invokeMethod('stop'); } catch (_) {}
    if (wasLive) _changes.add(null);
  }
}
