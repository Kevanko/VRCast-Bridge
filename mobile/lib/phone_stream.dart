import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;

/// Передаёт экран телефона на ПК: запись экрана → WebRTC → WHIP в MediaMTX на ПК.
class PhoneStream {
  static const _native = MethodChannel('vrcast/screen');

  RTCPeerConnection? _pc;
  RTCRtpSender? _sender;
  Timer? _keyframes;
  MediaStream? _stream;
  Uri? _resource; // адрес сессии WHIP, по нему её закрывают
  bool live = false;
  DateTime? startedAt;
  final _changes = StreamController<void>.broadcast();
  Stream<void> get changes => _changes.stream;

  /// [pc] — адрес ПК (http://хост:порт), [webrtcPort] — порт WebRTC на нём.
  Future<void> start(Uri pc, int webrtcPort) async {
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
      final sender = await connection.addTrack(stream.getVideoTracks().first, stream);
      _sender = sender;
      final parameters = sender.parameters;
      parameters.encodings = [RTCRtpEncoding(rid: null, active: true, maxBitrate: 3000000, maxFramerate: 30, scaleResolutionDownBy: 1.5)];
      await sender.setParameters(parameters);

      final gathered = Completer<void>();
      connection.onIceGatheringState = (state) {
        if (state == RTCIceGatheringState.RTCIceGatheringStateComplete && !gathered.isCompleted) gathered.complete();
      };
      final offer = await connection.createOffer({'offerToReceiveVideo': false, 'offerToReceiveAudio': false});
      await connection.setLocalDescription(offer);
      await gathered.future.timeout(const Duration(seconds: 4), onTimeout: () {});
      final local = await connection.getLocalDescription();

      final whip = pc.replace(port: webrtcPort, path: '/phone/whip');
      final response = await http.post(whip, headers: {'Content-Type': 'application/sdp'}, body: local!.sdp).timeout(const Duration(seconds: 10));
      if (response.statusCode != 201) throw 'ПК не принял поток (${response.statusCode}). Включён ли «Пульт для телефона»?';
      final location = response.headers['location'];
      if (location != null) _resource = whip.resolve(location);
      await connection.setRemoteDescription(RTCSessionDescription(response.body, 'answer'));
      connection.onConnectionState = (state) {
        if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed || state == RTCPeerConnectionState.RTCPeerConnectionStateClosed) stop();
      };
      stream.getVideoTracks().first.onEnded = stop;
      live = true;
      startedAt = DateTime.now();
      // Экран, который почти не меняется, ключевых кадров сам не шлёт, а ПК без них не может
      // начать читать поток. Поэтому подталкиваем кодек раз в пару секунд.
      _keyframes = Timer.periodic(const Duration(seconds: 2), (_) => _forceKeyframe());
      Timer(const Duration(milliseconds: 500), _forceKeyframe);
      _changes.add(null);
    } catch (e) {
      await stop();
      rethrow;
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
    final resource = _resource;
    final wasLive = live || _pc != null;
    live = false;
    _resource = null;
    if (resource != null) http.delete(resource).timeout(const Duration(seconds: 3)).catchError((Object _) => http.Response('', 0));
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
