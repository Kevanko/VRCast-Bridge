import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vrcast_remote/hls_source.dart';
import 'package:vrcast_remote/links.dart';
import 'package:vrcast_remote/media_server.dart';
import 'package:vrcast_remote/sites.dart';

// Живые проверки с настоящим интернетом: VRCAST_TEST_NET=1 flutter test test/sites_net_test.dart
void main() {
  liveYoutube();
  final enabled = Platform.environment['VRCAST_TEST_NET'] == '1';

  test('siteKind различает сайты', () {
    expect(siteKind(Uri.parse('https://rutube.ru/video/abc/')), 'rutube');
    expect(siteKind(Uri.parse('https://vkvideo.ru/video-1_2')), 'vk');
    expect(siteKind(Uri.parse('https://www.twitch.tv/somebody')), 'twitch');
    expect(siteKind(Uri.parse('https://anime.example/watch/1')), 'page');
  });

  test('общий разбор страницы находит m3u8 и mp4', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) {
      req.response.headers.contentType = ContentType.html;
      req.response.write(req.uri.path == '/a'
          ? '<html><head><title>Серия 1</title><meta property="og:image" content="/p.jpg"></head><body><script>var cfg={"file":"https:\\/\\/cdn.example\\/v\\/index.m3u8?t=1"}</script></body></html>'
          : req.uri.path == '/b'
              ? '<html><head><meta property="og:title" content="Фильм"></head><body><video src="/media/clip.mp4"></video></body></html>'
              : '<html><body>ничего</body></html>');
      req.response.close();
    });
    final a = await resolveSite(Uri.parse('http://127.0.0.1:${server.port}/a'));
    expect(a.url, 'https://cdn.example/v/index.m3u8?t=1');
    expect(a.title, 'Серия 1');
    final b = await resolveSite(Uri.parse('http://127.0.0.1:${server.port}/b'));
    expect(b.url, 'http://127.0.0.1:${server.port}/media/clip.mp4');
    expect(b.title, 'Фильм');
    await expectLater(resolveSite(Uri.parse('http://127.0.0.1:${server.port}/none')), throwsA(isA<SiteError>()));
  });

  test('Rutube: поток и описание по ссылке', skip: enabled ? false : 'нужен интернет', () async {
    final media = await resolveSite(Uri.parse('https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/'));
    print('rutube: ${media.title} ${media.duration} ${media.url}');
    expect(media.url, contains('.m3u8'));
    final playlist = await loadHls(Uri.parse(media.url));
    expect(playlist.segments, isNotEmpty);
  });

  test('Twitch: канал вне эфира даёт понятную ошибку или поток', skip: enabled ? false : 'нужен интернет', () async {
    try {
      final media = await resolveSite(Uri.parse('https://www.twitch.tv/twitch'));
      print('twitch live: ${media.url}');
      expect(media.live, isTrue);
    } on SiteError catch (e) {
      print('twitch: ${e.message}');
      expect(e.message, anyOf(contains('не в эфире'), contains('не найден')));
    }
  });
}

void liveYoutube() {
  final enabled = Platform.environment['VRCAST_TEST_NET'] == '1';
  test('YouTube Live: ссылка видна как эфир, плейлист открывается', skip: enabled ? false : 'нужен интернет', () async {
    final resolver = DefaultLinkResolver();
    final found = await resolver.inspect('https://www.youtube.com/watch?v=jfKfPfyJRdk');
    print('youtube: ${found.single.kind} ${found.single.title}');
    expect(found.single.kind, 'live');
    try {
      final source = await resolver.engineSource(SharedFile(id: 'x', path: '', title: found.single.title, url: found.single.url, kind: 'live', sourceId: found.single.sourceId), maxHeight: 720);
      expect(source.video, startsWith('http://127.0.0.1:'));
    } on UnsupportedLink catch (e) {
      print('youtube live: ${e.message}'); // YouTube может отказать этому адресу (проверка на бота): тогда эфир уйдёт с понятной причиной
    }
  });
}
