import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vrcast_remote/api.dart';
import 'package:vrcast_remote/models.dart';

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
}
