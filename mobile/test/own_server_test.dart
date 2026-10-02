import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vrcast_remote/api.dart';
import 'package:vrcast_remote/media_server.dart';
import 'package:vrcast_remote/models.dart';
import 'package:vrcast_remote/own_server.dart';
import 'package:vrcast_remote/phone_stream.dart';
import 'package:vrcast_remote/remote.dart';

void main() {
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await Prefs.instance.load();
  });

  group('OwnServer', () {
    test('адреса считаются от RTSP-порта: WebRTC на +11, ссылка на путь phone', () {
      final s = OwnServer(name: 'VPS', host: '203.0.113.7', rtspPort: 9554, key: 'k3y');
      expect(s.id, '203.0.113.7:9554');
      expect(s.whip.toString(), 'http://203.0.113.7:9565/phone/whip');
      expect(s.viewLink, 'rtspt://203.0.113.7:9554/phone');
      expect(s.basicAuth, 'Basic ${base64Encode(utf8.encode('vrcast:k3y'))}');
    });

    test('проверка ввода: адрес, порт и ключ', () {
      String? check(String host, String port, String key) => OwnServer.validate(host: host, port: port, key: key);
      expect(check('203.0.113.7', '8554', 'key'), isNull);
      expect(check('vps.example.com', '8554', 'key'), isNull);
      expect(check('', '8554', 'key'), contains('адрес'));
      expect(check('http://vps', '8554', 'key'), contains('Адрес'));
      expect(check('vps', '70000', 'key'), contains('Порт'));
      expect(check('vps', 'abc', 'key'), contains('Порт'));
      expect(check('vps', '8554', '  '), contains('ключ'));
    });

    test('ключ с ПК (publishKey) и свой формат читаются одинаково', () {
      final fromPc = OwnServer.fromJson({'name': 'Сервер', 'host': 'h', 'rtspPort': 8554, 'publishKey': 'abc'});
      final fromPhone = OwnServer.fromJson(fromPc.toJson().cast<String, dynamic>());
      expect(fromPhone.key, 'abc');
      expect(fromPhone.id, fromPc.id);
    });
  });

  group('Prefs: работа без ПК', () {
    test('серверы и выбор сохраняются между запусками', () async {
      Prefs.instance.saveOwnServer(OwnServer(name: 'А', host: 'a.example.com', key: '1'));
      Prefs.instance.saveOwnServer(OwnServer(name: 'Б', host: 'b.example.com', rtspPort: 9000, key: '2'));
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await Prefs.instance.load();
      expect(Prefs.instance.ownServers.map((e) => e.name), ['Б', 'А']);
      expect(Prefs.instance.currentOwnServer?.host, 'b.example.com');
      Prefs.instance.removeOwnServer(Prefs.instance.currentOwnServer!);
      expect(Prefs.instance.currentOwnServer?.host, 'a.example.com', reason: 'после удаления выбран оставшийся');
    });

    test('общие файлы: добавляются, убираются и переживают перезапуск; каждая правка меняет ревизию', () async {
      final start = Prefs.instance.shareRevision;
      Prefs.instance.addSharedFiles([SharedFile(id: 'a1', path: '/tmp/a.mp4', title: 'a.mp4'), SharedFile(id: 'b2', path: '/tmp/b.mp3', title: 'b.mp3')]);
      expect(Prefs.instance.shareRevision, start + 1);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await Prefs.instance.load();
      expect(Prefs.instance.sharedFiles.map((e) => e.id), ['a1', 'b2']);
      Prefs.instance.dropSharedFiles(['a1', 'нет-такого']);
      expect(Prefs.instance.sharedFiles.map((e) => e.id), ['b2']);
      expect(Prefs.instance.shareRevision, start + 2);
      Prefs.instance.saveOwnServer(OwnServer(name: 'Свой', host: 'h', key: 'k'));
      expect(Prefs.instance.shareRevision, start + 3, reason: 'сервер тоже уходит группе — ревизия растёт');
      Prefs.instance.removeOwnServer(Prefs.instance.ownServers.first);
      expect(Prefs.instance.shareRevision, start + 4);
    });

    test('качество с ПК запоминается для работы без ПК', () async {
      expect(Prefs.instance.standaloneQuality, '720p');
      Prefs.instance.mirrorProfile('1080p', 60);
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await Prefs.instance.load();
      expect(Prefs.instance.standaloneQuality, '1080p');
      expect(Prefs.instance.standaloneFps, 60);
    });

    test('ключи привязки хранятся отдельно для каждого ПК', () async {
      Prefs.instance.setToken('http://pc1:4717', 'aaa');
      Prefs.instance.setToken('http://pc2:4717', 'bbb');
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await Prefs.instance.load();
      expect(Prefs.instance.tokens, {'http://pc1:4717': 'aaa', 'http://pc2:4717': 'bbb'});
      Prefs.instance.setToken('http://pc1:4717', null);
      expect(Prefs.instance.tokens.keys, ['http://pc2:4717']);
    });
  });

  group('локальная копия ПК', () {
    Map<String, dynamic> status() => {
          'running': true, 'activeKind': 'queue', 'currentId': 'a', 'phoneSource': true,
          'queue': [{'id': 'a', 'title': 'Трек', 'duration': 10}],
          'config': {'outputMode': 'remote', 'quality': '1080p', 'fps': 60, 'pairedPhones': [{'id': 'x'}]},
          'progress': {'elapsed': 3, 'duration': 10},
          'performance': {'encoder': 'Процессор', 'outputProfile': {'quality': '1080p', 'fps': 60}, 'streamClock': 123.4},
          'rtsp': {'lanUrls': ['rtspt://1.2.3.4:4718/live'], 'remote': {'secret': 'x'}},
        };

    test('копия хранит очередь и настройки, но не ход воспроизведения и не лишнее', () async {
      Prefs.instance.cacheState(status());
      final saved = jsonDecode(Prefs.instance.cachedState!) as Map<String, dynamic>;
      expect(saved.keys, containsAll(['queue', 'config', 'performance', 'rtsp']));
      expect(saved.containsKey('progress'), isFalse, reason: 'иначе запись шла бы каждую секунду');
      expect((saved['performance'] as Map).containsKey('streamClock'), isFalse);
      expect((saved['config'] as Map).containsKey('pairedPhones'), isFalse);
      expect((saved['rtsp'] as Map).containsKey('remote'), isFalse);
    });

    test('без изменений копия не переписывается', () {
      Prefs.instance.cacheState(status());
      final first = Prefs.instance.cachedState;
      final json = status();
      (json['progress'] as Map)['elapsed'] = 9; // ход воспроизведения
      Prefs.instance.cacheState(json);
      expect(identical(Prefs.instance.cachedState, first) || Prefs.instance.cachedState == first, isTrue);
    });

    test('без связи эфир не «идёт», а очередь и настройки остаются', () {
      final s = BridgeState.offlineFrom(status());
      expect(s.running, isFalse);
      expect(s.phoneSource, isFalse);
      expect(s.currentId, isEmpty);
      expect(s.queue.single.title, 'Трек');
      expect(s.profileQuality, '1080p');
      expect(s.outputMode, 'remote');
      expect(BridgeState.offlineFrom(const {}).queue, isEmpty);
    });

    test('отложенные ссылки не дублируются и переживают перезапуск', () async {
      Prefs.instance.addPendingLink('https://a');
      Prefs.instance.addPendingLink('https://a');
      Prefs.instance.addPendingLink('https://b');
      await Future<void>.delayed(const Duration(milliseconds: 50));
      await Prefs.instance.load();
      expect(Prefs.instance.pendingLinks, ['https://a', 'https://b']);
    });
  });

  test('файлы и серверы уходят группе с ключом привязки; ПК отвечает, что убрали другие', () async {
    final seen = <String>[];
    final api = Api(Uri.parse('http://pc:4717'), token: 'tok', client: MockClient((request) async {
      seen.add('${request.method} ${request.url.path} ${request.headers['X-VRCast-Token']} ${request.body}');
      return http.Response.bytes(utf8.encode(jsonEncode({'removed': ['b2'], 'controller': null})), 200, headers: {'content-type': 'application/json; charset=utf-8'});
    }));
    final removed = await api.contribute(
      mediaBase: 'http://192.168.1.50:4242',
      mediaKey: 'key-key-key-key-key-key',
      files: [{'id': 'a1', 'title': 'a.mp4'}],
      servers: [OwnServer(name: 'Мой VPS', host: '203.0.113.9', key: 'sec')],
    );
    expect(removed, ['b2']);
    final sent = jsonDecode(seen.single.split('tok ').last) as Map;
    expect(seen.single, startsWith('POST /api/group/contribute tok'));
    expect(sent['media'], {'base': 'http://192.168.1.50:4242', 'key': 'key-key-key-key-key-key'});
    expect(sent['queue'], [{'id': 'a1', 'title': 'a.mp4'}]);
    expect((sent['servers'] as List).single, {'id': '203.0.113.9:8554', 'name': 'Мой VPS', 'host': '203.0.113.9', 'rtspPort': 8554, 'publishKey': 'sec'});
  });

  group('кодек для сервера', () {
    final vp8 = RTCRtpCodecCapability(mimeType: 'video/VP8', clockRate: 90000);
    final h264a = RTCRtpCodecCapability(mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'profile-level-id=42e01f');
    final h264b = RTCRtpCodecCapability(mimeType: 'video/h264', clockRate: 90000, sdpFmtpLine: 'profile-level-id=640c1f');

    test('остаются только H.264-варианты, в любом регистре', () {
      expect(h264Codecs([vp8, h264a, h264b]), [h264a, h264b]);
    });

    test('нет H.264 — пустой список (приложение предупредит)', () {
      expect(h264Codecs([vp8]), isEmpty);
      final stream = PhoneStream()..selectedCodec = 'нет H.264';
      expect(stream.lacksH264, isTrue);
      expect(PhoneStream().lacksH264, isFalse);
    });
  });

  group('битрейт отправки на свой сервер', () {
    test('по качеству, экономнее домашней сети', () {
      expect(directBitrateKbps('480p'), 1200);
      expect(directBitrateKbps('720p'), 2500);
      expect(directBitrateKbps('1080p'), 4000);
      expect(directBitrateKbps('что-то'), 2500);
    });

    test('в расчёте отправки низкий битрейт не поднимается до домашнего', () {
      final plan = phoneEncoding(quality: '480p', fps: 30, bitrateKbps: directBitrateKbps('480p'), width: 1080, height: 2400);
      expect(plan.bitrate, 1200000);
      expect(plan.scale, closeTo(5, 0.001));
    });
  });
}
