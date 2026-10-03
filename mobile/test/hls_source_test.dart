import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:vrcast_remote/hls_source.dart';

void main() {
  late HttpServer origin;
  final parts = [for (var i = 0; i < 3; i++) Uint8List.fromList(List.generate(1000 + i * 7, (k) => (k * 3 + i) & 255))];

  setUp(() async {
    origin = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    origin.listen((req) {
      final name = req.uri.path;
      if (name == '/live.m3u8') {
        req.response.write('#EXTM3U\n#EXTINF:4.0,\ns0.ts\n#EXTINF:4.5,\ns1.ts\n');
      } else if (name.endsWith('/vod.m3u8')) {
        req.response.write('#EXTM3U\n#EXTINF:4.0,\ns0.ts\n#EXTINF:4.5,\ns1.ts\n#EXTINF:2,\ns2.ts\n#EXT-X-ENDLIST\n');
      } else if (name == '/master.m3u8') {
        req.response.write('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=640x360\nlow/vod.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900,RESOLUTION=1920x1080\nhigh/vod.m3u8\n');
      } else {
        final index = int.tryParse(RegExp(r's(\d)\.ts').firstMatch(name)?.group(1) ?? '');
        if (index == null) {
          req.response.statusCode = 404;
        } else {
          req.response.add(parts[index]);
        }
      }
      req.response.close();
    });
  });
  tearDown(() => origin.close(force: true));

  Uri at(String path) => Uri.parse('http://127.0.0.1:${origin.port}$path');

  test('плейлист: длительность, сегменты, прямой эфир отклоняется', () async {
    final vod = await loadHls(at('/vod.m3u8'));
    expect(vod.segments, hasLength(3));
    expect(vod.duration, closeTo(10.5, 0.001));
    expect(() => loadHls(at('/live.m3u8')), throwsA(isA<HlsUnsupported>()));
  });

  test('главный плейлист: берётся лучший вариант не выше нужной высоты', () async {
    expect(parseMedia('#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST', Uri.parse('http://h/x/y.m3u8')).segments.single.toString(), 'http://h/x/a.ts');
    final low = await loadHls(at('/master.m3u8'), maxHeight: 720);
    expect(low.segments.first.path, '/low/s0.ts');
  });

  test('склейка: файл целиком и по Range совпадает с сегментами подряд', () async {
    final server = await HlsConcatServer.start(await loadHls(at('/vod.m3u8')));
    addTearDown(server.close);
    final all = [for (final p in parts) ...p];
    final client = HttpClient();
    addTearDown(() => client.close(force: true));
    Future<List<int>> get(String? range) async {
      final request = await client.getUrl(server.url);
      if (range != null) request.headers.set('range', range);
      final response = await request.close();
      return [for (final chunk in await response.toList()) ...chunk];
    }

    expect(await get(null), all);
    expect(await get('bytes=900-2100'), all.sublist(900, 2101)); // через границу двух сегментов
    expect(await get('bytes=${all.length - 50}-'), all.sublist(all.length - 50));
  });
}
