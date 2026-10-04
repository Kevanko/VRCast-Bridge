import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

/// Что нашлось на странице сайта: поток (mp4 или m3u8) и описание. Поток живёт недолго, поэтому адрес страницы хранится
/// в очереди, а поток берётся прямо перед запуском.
class SiteMedia {
  SiteMedia({required this.url, required this.title, this.duration = 0, this.thumbnail = '', this.live = false, this.headers = const {}});
  final String url;
  final String title;
  final double duration;
  final String thumbnail;
  final bool live;
  final Map<String, String> headers;
}

class SiteError implements Exception {
  SiteError(this.message);
  final String message;
  @override
  String toString() => message;
}

const _browser = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

/// Как называется разборщик для адреса: по нему очередь знает, откуда ролик. Пустая строка — обычная страница (общий разбор).
String siteKind(Uri uri) {
  final host = uri.host.toLowerCase();
  if (host.endsWith('rutube.ru')) return 'rutube';
  if (host == 'vk.com' || host.endsWith('.vk.com') || host.endsWith('vkvideo.ru') || host.endsWith('vk.ru')) return 'vk';
  if (host.endsWith('twitch.tv')) return 'twitch';
  return 'page';
}

Future<SiteMedia> resolveSite(Uri page, {http.Client? client}) async {
  final own = client == null;
  final http_ = client ?? http.Client();
  try {
    switch (siteKind(page)) {
      case 'rutube':
        return await _rutube(page, http_);
      case 'vk':
        return await _vk(page, http_);
      case 'twitch':
        return await _twitch(page, http_);
      default:
        return await _page(page, http_);
    }
  } on SiteError {
    rethrow;
  } catch (e) {
    throw SiteError('Не удалось открыть страницу: $e');
  } finally {
    if (own) http_.close();
  }
}

Future<http.Response> _get(http.Client client, Uri uri, {Map<String, String> headers = const {}}) =>
    client.get(uri, headers: {'user-agent': _browser, 'accept-language': 'ru,en;q=0.8', ...headers}).timeout(const Duration(seconds: 15));

String _unescape(String raw) => raw.replaceAll(r'\/', '/').replaceAll(r'&', '&').replaceAll('&amp;', '&');

// ── Rutube ──

Future<SiteMedia> _rutube(Uri page, http.Client client) async {
  final id = RegExp(r'([0-9a-f]{32})').firstMatch(page.path)?.group(1);
  if (id == null) throw SiteError('Не получилось понять ссылку на Rutube');
  final response = await _get(client, Uri.parse('https://rutube.ru/api/play/options/$id/?no_404=true&referer=https%3A%2F%2Frutube.ru'));
  if (response.statusCode != 200) throw SiteError('Rutube ответил ${response.statusCode}');
  final data = jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
  final balancer = (data['video_balancer'] as Map?)?.cast<String, dynamic>();
  final url = '${balancer?['m3u8'] ?? balancer?['default'] ?? ''}';
  if (url.isEmpty) throw SiteError('У этого видео на Rutube нет потока (закрыто или недоступно в регионе)');
  return SiteMedia(
    url: url,
    title: '${data['title'] ?? 'Rutube'}',
    duration: (data['duration'] as num?)?.toDouble() ?? 0,
    thumbnail: '${data['thumbnail_url'] ?? ''}',
    live: data['is_livestream'] == true,
  );
}

// ── VK ──

Future<SiteMedia> _vk(Uri page, http.Client client) async {
  final text = '${page.path}?${page.query}';
  final match = RegExp(r'video(-?\d+)_(\d+)').firstMatch(text);
  if (match == null) throw SiteError('Не получилось понять ссылку на видео VK');
  final hash = RegExp(r'[?&]hash=([0-9a-f]+)').firstMatch(text)?.group(1);
  final ext = Uri.parse('https://vk.com/video_ext.php?oid=${match.group(1)}&id=${match.group(2)}${hash == null ? '' : '&hash=$hash'}');
  final response = await _get(client, ext, headers: {'referer': 'https://vk.com/'});
  final body = utf8.decode(response.bodyBytes, allowMalformed: true);
  String? field(String name) => RegExp('"$name":\\s*"([^"]+)"').firstMatch(body)?.group(1);
  final title = field('md_title') ?? field('title') ?? 'VK';
  final hls = field('hls') ?? field('hls_ondemand');
  if (hls != null) {
    return SiteMedia(
      url: _unescape(hls),
      title: _decodeJs(title),
      duration: double.tryParse(RegExp(r'"duration":\s*(\d+)').firstMatch(body)?.group(1) ?? '') ?? 0,
      thumbnail: _unescape(field('jpg') ?? ''),
      live: body.contains('"is_live":true') || body.contains('"live":1'),
      headers: {'referer': 'https://vk.com/'},
    );
  }
  // Готовые mp4: берём лучший не выше 720p.
  final mp4s = <int, String>{};
  for (final m in RegExp(r'"url(\d+)":\s*"([^"]+)"').allMatches(body)) {
    mp4s[int.parse(m.group(1)!)] = _unescape(m.group(2)!);
  }
  final heights = mp4s.keys.where((h) => h <= 720).toList()..sort();
  if (heights.isEmpty && mp4s.isEmpty) throw SiteError('VK не отдал поток: видео закрыто или нужен вход в аккаунт');
  final height = heights.isEmpty ? (mp4s.keys.toList()..sort()).first : heights.last;
  return SiteMedia(
    url: mp4s[height]!,
    title: _decodeJs(title),
    duration: double.tryParse(RegExp(r'"duration":\s*(\d+)').firstMatch(body)?.group(1) ?? '') ?? 0,
    thumbnail: _unescape(field('jpg') ?? ''),
    headers: {'referer': 'https://vk.com/'},
  );
}

String _decodeJs(String raw) => raw.replaceAllMapped(RegExp(r'\\u([0-9a-fA-F]{4})'), (m) => String.fromCharCode(int.parse(m.group(1)!, radix: 16))).replaceAll(r'\/', '/');

// ── Twitch ──

const _twitchClient = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const _twitchQuery = r'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {'
    r' streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename }'
    r' videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }';

Future<SiteMedia> _twitch(Uri page, http.Client client) async {
  final segments = page.pathSegments.where((s) => s.isNotEmpty).toList();
  final vodId = segments.length >= 2 && segments[segments.length - 2] == 'videos' ? segments.last : RegExp(r'^/videos/(\d+)').firstMatch(page.path)?.group(1);
  final isVod = vodId != null;
  if (!isVod && (segments.isEmpty || segments.contains('clip') || page.host.startsWith('clips.'))) throw SiteError('Клипы Twitch телефон пока не разбирает: вставьте ссылку на канал или запись');
  final login = isVod ? '' : segments.first.toLowerCase();
  final response = await client.post(Uri.parse('https://gql.twitch.tv/gql'),
      headers: {'client-id': _twitchClient, 'content-type': 'application/json', 'user-agent': _browser},
      body: jsonEncode({
        'operationName': 'PlaybackAccessToken_Template',
        'query': _twitchQuery,
        'variables': {'isLive': !isVod, 'login': login, 'isVod': isVod, 'vodID': vodId ?? '', 'playerType': 'site'},
      })).timeout(const Duration(seconds: 15));
  if (response.statusCode != 200) throw SiteError('Twitch ответил ${response.statusCode}');
  final data = ((jsonDecode(utf8.decode(response.bodyBytes)) as Map)['data'] as Map?)?.cast<String, dynamic>() ?? const {};
  final token = (isVod ? data['videoPlaybackAccessToken'] : data['streamPlaybackAccessToken']) as Map?;
  if (token == null) throw SiteError(isVod ? 'Запись Twitch недоступна' : 'Канал «$login» не найден');
  final query = {
    'allow_source': 'true',
    'allow_audio_only': 'true',
    'allow_spectre': 'true',
    'player': 'twitchweb',
    'playlist_include_framerate': 'true',
    'sig': '${token['signature']}',
    'token': '${token['value']}',
    'p': '${Random().nextInt(1000000)}',
  };
  final base = isVod ? 'https://usher.ttvnw.net/vod/$vodId.m3u8' : 'https://usher.ttvnw.net/api/channel/hls/$login.m3u8';
  final url = Uri.parse(base).replace(queryParameters: query).toString();
  // Канал не в эфире: плейлист отвечает 404, а понятнее сказать сразу.
  final probe = await _get(client, Uri.parse(url));
  if (probe.statusCode == 404) throw SiteError(isVod ? 'Запись Twitch не найдена' : 'Канал «$login» сейчас не в эфире');
  if (probe.statusCode != 200) throw SiteError('Twitch не отдал поток (${probe.statusCode})');
  return SiteMedia(url: url, title: isVod ? 'Twitch: запись $vodId' : 'Twitch: $login', live: !isVod);
}

// ── Любая страница: ищем видео так же, как плеер на странице ──

Future<SiteMedia> _page(Uri page, http.Client client) async {
  final response = await _get(client, page);
  if (response.statusCode != 200) throw SiteError('Сайт ответил ${response.statusCode}');
  final html = utf8.decode(response.bodyBytes, allowMalformed: true);
  String? meta(String property) {
    for (final m in RegExp('<meta[^>]+(?:property|name)=["\']$property["\'][^>]*>', caseSensitive: false).allMatches(html)) {
      final content = RegExp('content=["\']([^"\']+)["\']', caseSensitive: false).firstMatch(m.group(0)!)?.group(1);
      if (content != null) return content;
    }
    return null;
  }

  final candidates = <String>[
    for (final p in ['og:video:url', 'og:video:secure_url', 'og:video', 'twitter:player:stream']) ...[meta(p)].whereType<String>(),
    for (final m in RegExp(r'''https?:\\?/\\?/[^\s"'<>\\]+(?:\\/[^\s"'<>\\]+)*\.m3u8[^\s"'<>\\]*''').allMatches(html)) m.group(0)!,
    for (final m in RegExp('<(?:video|source)[^>]+src=["\']([^"\']+)["\']', caseSensitive: false).allMatches(html)) m.group(1)!,
    for (final m in RegExp(r'''https?:\\?/\\?/[^\s"'<>\\]+(?:\\/[^\s"'<>\\]+)*\.(?:mp4|webm|mkv)(?:\?[^\s"'<>\\]*)?''').allMatches(html)) m.group(0)!,
  ];
  for (final raw in candidates) {
    final resolved = page.resolve(_unescape(raw));
    final path = resolved.path.toLowerCase();
    if (!(resolved.scheme == 'http' || resolved.scheme == 'https')) continue;
    if (!(path.endsWith('.m3u8') || path.endsWith('.mp4') || path.endsWith('.webm') || path.endsWith('.mkv') || path.endsWith('.mov'))) continue;
    final title = meta('og:title') ?? RegExp(r'<title[^>]*>([^<]+)</title>', caseSensitive: false).firstMatch(html)?.group(1)?.trim() ?? page.host;
    return SiteMedia(
      url: resolved.toString(),
      title: title.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'"),
      thumbnail: meta('og:image') ?? '',
      headers: {'referer': page.toString()},
    );
  }
  throw SiteError('На странице не нашлось видео, которое можно открыть без ПК');
}
