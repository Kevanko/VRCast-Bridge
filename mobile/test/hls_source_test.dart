import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pointycastle/export.dart';
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
    final live = await loadHls(at('/live.m3u8'));
    expect(live.live, isTrue);
    expect(live.duration, 0);
  });

  test('главный плейлист: берётся лучший вариант не выше нужной высоты', () async {
    expect(parseMedia('#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST', Uri.parse('http://h/x/y.m3u8')).segments.single.uri.toString(), 'http://h/x/a.ts');
    final low = await loadHls(at('/master.m3u8'), maxHeight: 720);
    expect(low.segments.first.uri.path, '/low/s0.ts');
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

  test('шифрование AES-128: сегменты расшифровываются, длина файла считается верно', () async {
    final key = Uint8List.fromList(List.generate(16, (i) => i * 11 + 1));
    Uint8List encrypt(Uint8List plain, Uint8List iv) {
      final pad = 16 - plain.length % 16;
      final padded = Uint8List(plain.length + pad)..setAll(0, plain)..fillRange(plain.length, plain.length + pad, pad);
      final cipher = CBCBlockCipher(AESEngine())..init(true, ParametersWithIV(KeyParameter(key), iv));
      final out = Uint8List(padded.length);
      for (var o = 0; o < padded.length; o += 16) {
        cipher.processBlock(padded, o, out, o);
      }
      return out;
    }

    Uint8List seqIv(int n) => Uint8List(16)..[15] = n;
    final secured = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => secured.close(force: true));
    secured.listen((req) {
      final path = req.uri.path;
      if (path == '/enc.m3u8') {
        req.response.write('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin"\n#EXTINF:4,\ne0.ts\n#EXTINF:4,\ne1.ts\n#EXT-X-ENDLIST\n');
      } else if (path == '/k.bin') {
        req.response.add(key);
      } else {
        final n = int.parse(RegExp(r'e(\d)').firstMatch(path)!.group(1)!);
        final body = encrypt(parts[n], seqIv(n));
        final range = RegExp(r'bytes=(\d+)-(\d+)').firstMatch(req.headers.value('range') ?? '');
        if (range != null) {
          req.response.statusCode = 206;
          req.response.add(body.sublist(int.parse(range.group(1)!), int.parse(range.group(2)!) + 1));
        } else {
          req.response.add(body);
        }
      }
      req.response.close();
    });
    final server = await HlsConcatServer.start(await loadHls(Uri.parse('http://127.0.0.1:${secured.port}/enc.m3u8')));
    addTearDown(server.close);
    final client = HttpClient();
    addTearDown(() => client.close(force: true));
    final response = await (await client.getUrl(server.url)).close();
    expect([for (final chunk in await response.toList()) ...chunk], [...parts[0], ...parts[1]]);
  });

  test('эфир: сегменты приходят по мере появления плейлиста', () async {
    var round = 0;
    final live = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => live.close(force: true));
    live.listen((req) {
      final path = req.uri.path;
      if (path == '/l.m3u8') {
        round++;
        final start = round > 1 ? 1 : 0;
        req.response.write('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:$start\n');
        for (var i = start; i < start + 2; i++) {
          req.response.write('#EXTINF:1,\ns$i.ts\n');
        }
        if (round > 2) req.response.write('#EXT-X-ENDLIST\n');
      } else {
        req.response.add(parts[int.parse(RegExp(r's(\d)').firstMatch(path)!.group(1)!)]);
      }
      req.response.close();
    });
    final playlist = await loadHls(Uri.parse('http://127.0.0.1:${live.port}/l.m3u8'));
    expect(playlist.live, isTrue);
    final server = await HlsConcatServer.start(playlist);
    addTearDown(server.close);
    final client = HttpClient();
    addTearDown(() => client.close(force: true));
    final response = await (await client.getUrl(server.url)).close();
    final got = [for (final chunk in await response.toList().timeout(const Duration(seconds: 15))) ...chunk];
    expect(got, [...parts[0], ...parts[1], ...parts[2]]);
  });
}
