import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vrcast_remote/media_server.dart';

void main() {
  const key = 'abcdefghijklmnopqrstuvwx';
  final bytes = List<int>.generate(1000, (i) => i % 251);
  late Directory dir;
  late MediaServer server;
  late int port;
  final client = HttpClient();

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('vrcast-media');
    final file = File('${dir.path}/clip.mp4')..writeAsBytesSync(bytes);
    final gone = SharedFile(id: 'gone', path: '${dir.path}/нет.mp4', title: 'пропал');
    server = MediaServer(files: () => [SharedFile(id: 'abc', path: file.path, title: 'clip'), gone], key: key);
    port = await server.start();
  });
  tearDown(() async {
    await server.stop();
    await dir.delete(recursive: true);
  });

  Future<({int status, List<int> body, HttpHeaders headers})> fetch(String path, {String method = 'GET', Map<String, String> headers = const {}}) async {
    final request = await client.openUrl(method, Uri.parse('http://127.0.0.1:$port$path'));
    headers.forEach(request.headers.set);
    final response = await request.close();
    final body = await response.fold<List<int>>([], (all, chunk) => all..addAll(chunk));
    return (status: response.statusCode, body: body, headers: response.headers);
  }

  test('файл отдаётся целиком по ключу', () async {
    final r = await fetch('/api/media/abc?k=$key');
    expect(r.status, 200);
    expect(r.body, bytes);
    expect(r.headers.value('accept-ranges'), 'bytes');
    expect(r.headers.contentType?.mimeType, 'video/mp4');
  });

  test('перемотка: диапазон, открытый конец, последние байты', () async {
    final part = await fetch('/api/media/abc?k=$key', headers: {'range': 'bytes=100-199'});
    expect(part.status, 206);
    expect(part.body, bytes.sublist(100, 200));
    expect(part.headers.value('content-range'), 'bytes 100-199/1000');
    final tail = await fetch('/api/media/abc?k=$key', headers: {'range': 'bytes=900-'});
    expect(tail.body, bytes.sublist(900));
    final last = await fetch('/api/media/abc?k=$key', headers: {'range': 'bytes=-50'});
    expect(last.body, bytes.sublist(950));
    final beyond = await fetch('/api/media/abc?k=$key', headers: {'range': 'bytes=5000-'});
    expect(beyond.status, 416);
  });

  test('без ключа, с чужим ключом, с неизвестным файлом и чужим методом — отказ', () async {
    expect((await fetch('/api/media/abc')).status, 403);
    expect((await fetch('/api/media/abc?k=wrongwrongwrongwrongwron')).status, 403);
    expect((await fetch('/api/media/abc?k=short')).status, 403);
    expect((await fetch('/api/media/unknown?k=$key')).status, 403);
    expect((await fetch('/api/media/abc?k=$key', method: 'POST')).status, 403);
    expect((await fetch('/api/media/..%2Fetc%2Fpasswd?k=$key')).status, 403);
    expect((await fetch('/other?k=$key')).status, 403);
  });

  test('файл удалили с телефона — 404, а HEAD отдаёт только заголовки', () async {
    expect((await fetch('/api/media/gone?k=$key')).status, 404);
    final head = await fetch('/api/media/abc?k=$key', method: 'HEAD');
    expect(head.status, 200);
    expect(head.body, isEmpty);
    expect(head.headers.contentLength, 1000);
  });

  test('идентификатор нового файла — из букв и цифр, ключи разные', () {
    final id = SharedFile.newId();
    expect(RegExp(r'^[a-z0-9]{10}$').hasMatch(id), isTrue);
    expect(SharedFile.newId(), isNot(id));
    expect(MediaServer(files: () => []).key, isNot(MediaServer(files: () => []).key));
    expect(MediaServer(files: () => []).key.length, greaterThanOrEqualTo(16));
  });
}
