import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vrcast_remote/api.dart';
import 'package:vrcast_remote/models.dart';
import 'package:vrcast_remote/phone_stream.dart';

Map<String, dynamic> fixture() => (jsonDecode(File('test/fixtures/status.json').readAsStringSync()) as Map).cast<String, dynamic>();

void main() {
  test('статус с настоящего сервера разбирается', () {
    final s = BridgeState.fromJson(fixture());
    expect(s.running, isTrue);
    expect(s.activeKind, 'queue');
    expect(s.queue, hasLength(1));
    expect(s.current?.title, 'demo.mp4');
    expect(s.duration, 60);
    expect(s.canSeek, isTrue);
    expect(s.loopMode, 'once');
    expect(s.streamReady, isTrue);
    expect(s.rtspLanUrls.first, startsWith('rtspt://'));
    expect(s.statusLabel, 'Идёт эфир');
  });

  test('пустой и неполный статус не падает', () {
    final s = BridgeState.fromJson({});
    expect(s.running, isFalse);
    expect(s.queue, isEmpty);
    expect(s.statusLabel, 'Эфир остановлен');
  });

  test('позиция между событиями идёт по своим часам и не выходит за длительность', () {
    final s = BridgeState.fromJson(fixture());
    final later = s.receivedAt.add(const Duration(seconds: 4));
    expect(s.positionAt(later), closeTo(s.elapsed + 4, 0.01));
    expect(s.positionAt(s.receivedAt.add(const Duration(hours: 1))), s.duration);
    final paused = BridgeState.fromJson(fixture()..['playback'] = {'paused': true, 'canSeek': true});
    expect(paused.positionAt(later), paused.elapsed);
  });

  test('время форматируется как на плеере', () {
    expect(formatTime(0), '0:00');
    expect(formatTime(65), '1:05');
    expect(formatTime(3725), '1:02:05');
    expect(formatTime(double.nan), '0:00');
  });

  test('SSE: события собираются из кусков, комментарии игнорируются', () async {
    final chunks = Stream.fromIterable([
      utf8.encode('retry: 2000\n\ndata: {"a"'),
      utf8.encode(':1}\n\n: ping\n\ndata: {"b":2}\n'),
      utf8.encode('\n'),
    ]);
    expect(await parseSse(chunks).toList(), ['{"a":1}', '{"b":2}']);
  });

  test('команды уходят на нужные адреса с телом', () async {
    final calls = <String>[];
    final client = MockClient((request) async {
      calls.add('${request.method} ${request.url.path} ${request.body}');
      return http.Response('{}', 200);
    });
    final api = Api(Uri.parse('http://192.168.1.5:4717'), client: client);
    await api.playback('seek', {'position': 12.5});
    await api.startQueue('abc');
    await api.removeFromQueue('a b');
    await api.moveInQueue('x', 2);
    await api.stop();
    expect(calls, [
      'POST /api/playback {"action":"seek","position":12.5}',
      'POST /api/start/queue {"id":"abc"}',
      'DELETE /api/queue/a%20b ',
      'POST /api/queue/move {"id":"x","to":2}',
      'POST /api/stop {}',
    ]);
  });

  test('ошибка сервера превращается в понятное сообщение', () async {
    final api = Api(Uri.parse('http://pc:4717'), client: MockClient((_) async => http.Response.bytes(utf8.encode('{"error":"Пульт для телефона выключен."}'), 403, headers: {'content-type': 'application/json; charset=utf-8'})));
    expect(() => api.playback('pause'), throwsA(isA<ApiException>().having((e) => e.message, 'message', 'Пульт для телефона выключен.')));
  });

  test('адреса картинок строятся от адреса ПК', () {
    final api = Api(Uri.parse('http://192.168.1.5:4717'));
    expect(api.absolute('/thumbs/a.jpg?v=1'), 'http://192.168.1.5:4717/thumbs/a.jpg?v=1');
    expect(api.absolute('http://x/y'), 'http://x/y');
  });

  test('настройки эфира и список серверов (только названия) разбираются', () {
    final json = fixture();
    (json['config'] as Map)['outputMode'] = 'remote';
    (json['config'] as Map)['activeServerId'] = 's2';
    (json['config'] as Map)['servers'] = [
      {'id': 's1', 'name': 'Первый', 'reachable': true},
      {'id': 's2', 'name': 'Второй', 'reachable': null},
    ];
    final s = BridgeState.fromJson(json);
    expect(s.outputMode, 'remote');
    expect(s.activeServerId, 's2');
    expect(s.servers.map((e) => e.name), ['Первый', 'Второй']);
    expect(s.servers[1].reachable, isNull);
    expect(s.quality, isNotEmpty);
    expect(BridgeState.fromJson({}).outputMode, 'local');
  });

  test('привязка: ключ уходит в заголовке, настройки — в /api/config', () async {
    final calls = <String>[];
    final client = MockClient((request) async {
      calls.add('${request.method} ${request.url.path} token=${request.headers['X-VRCast-Token']} ${request.body}');
      if (request.url.path == '/api/pair') return http.Response('{"token":"abc123"}', 200);
      if (request.url.path == '/api/pair/check') return http.Response.bytes(utf8.encode('{"error":"Нужна привязка"}'), 401, headers: {'content-type': 'application/json; charset=utf-8'});
      return http.Response('{}', 200);
    });
    final api = Api(Uri.parse('http://pc:4717'), client: client);
    expect(await api.pairCheck(), isFalse);
    final token = await api.pair('123456', 'Телефон');
    expect(token, 'abc123');
    api.token = token;
    await api.setStream({'outputMode': 'tunnel', 'quality': '1080p'});
    expect(calls, [
      'GET /api/pair/check token=null ',
      'POST /api/pair token=null {"code":"123456","name":"Телефон","kind":"phone"}',
      'POST /api/config token=abc123 {"outputMode":"tunnel","quality":"1080p"}',
    ]);
  });

  test('профиль эфира ПК и состояние доставки разбираются', () {
    final s = BridgeState.fromJson(fixture());
    expect(s.profileQuality, '720p');
    expect(s.profileFps, 60);
    expect(s.profileBitrateKbps, 4800);
    expect(s.encoderLabel, 'Процессор');
    expect(s.deliveryReady, isFalse);
    expect(s.deliveryError, isEmpty);
    expect(s.pendingProfile, isEmpty);
    final json = fixture();
    (json['performance'] as Map)['pendingProfile'] = true;
    (json['performance'] as Map)['desiredProfile'] = {'quality': '1080p', 'fps': 30};
    expect(BridgeState.fromJson(json).pendingProfile, '1080p · 30 к/с');
    final bare = BridgeState.fromJson({'config': {'quality': '1080p', 'fps': 30}});
    expect(bare.profileQuality, '1080p', reason: 'без профиля берём выбранное в настройках');
    expect(bare.profileBitrateKbps, 0);
  });

  test('отправка экрана подстраивается под профиль ПК', () {
    // Экран 1080x2400: для 720p длинную сторону уменьшаем до 720, для 480p — до 480.
    final p720 = phoneEncoding(quality: '720p', fps: 60, bitrateKbps: 4800, width: 1080, height: 2400);
    expect(p720.scale, closeTo(2400 / 720, 0.001));
    expect(p720.bitrate, 4800000);
    expect(p720.fps, 60);
    final p480 = phoneEncoding(quality: '480p', fps: 30, bitrateKbps: 0, width: 1080, height: 2400);
    expect(p480.scale, closeTo(5, 0.001));
    expect(p480.bitrate, 1500000, reason: 'авто-битрейт зависит от качества');
    expect(p480.fps, 30);
    final small = phoneEncoding(quality: '1080p', fps: 30, bitrateKbps: 20000, width: 540, height: 960);
    expect(small.scale, 1.0, reason: 'маленький экран не увеличиваем');
    expect(small.bitrate, 8000000, reason: 'потолок битрейта');
  });
}
