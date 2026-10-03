import 'dart:convert';
import 'dart:io';

import 'package:youtube_explode_dart/youtube_explode_dart.dart';

import 'byte_source.dart';
import 'hls_source.dart';
import 'media_server.dart';
import 'mp4.dart';

/// Что нашлось по ссылке: название, длительность и обложка видны в очереди сразу, поток берётся при запуске.
class LinkInfo {
  LinkInfo({required this.url, required this.title, required this.duration, required this.thumbnail, required this.kind, this.sourceId = ''});
  final String url;
  final String title;
  final double duration;
  final String thumbnail;
  final String kind; // 'youtube' | 'direct'
  final String sourceId;

  SharedFile toItem() => SharedFile(id: SharedFile.newId(), path: '', title: title, url: url, duration: duration, thumbnail: thumbnail, kind: kind, sourceId: sourceId);
}

/// Ссылку без ПК разобрать нельзя (VK, Rutube, Twitch и т. п. разбирает только ПК).
class UnsupportedLink implements Exception {
  UnsupportedLink(this.message, {this.sendToPc = false});
  final String message;
  /// Ссылку без ПК не открыть, но ПК её разберёт: она ждёт подключения. Иначе это сбой (нет сети и т. п.) — повторите.
  final bool sendToPc;
  @override
  String toString() => message;
}

/// Как телефон сам разбирает ссылки и открывает их для эфира.
abstract class LinkResolver {
  /// Одно видео или целый плейлист.
  Future<List<LinkInfo>> inspect(String url);

  /// Открыть поток ролика (адрес потока YouTube живёт несколько часов, поэтому берётся прямо перед запуском).
  Future<ByteSource> open(SharedFile item);
}

/// Что отдать движку перекодирования: у YouTube картинка и звук лежат в разных файлах.
class EngineSource {
  const EngineSource({this.video, this.audio});
  final String? video;
  final String? audio;
}

/// Умеет выдать источники для перекодирования (в том числе HD с YouTube, которого нет в готовых mp4).
abstract class EngineLinkResolver {
  Future<EngineSource> engineSource(SharedFile item, {required int maxHeight});
}

class DefaultLinkResolver implements LinkResolver, EngineLinkResolver {
  static final _m3u8 = RegExp(r'\.m3u8$', caseSensitive: false);
  static final _mp4 = RegExp(r'\.(mp4|m4v|mov|m4a)$', caseSensitive: false);
  // Остальное телефон перекодирует сам (MediaExtractor читает эти контейнеры и HLS), длительность узнаёт движок.
  static final _direct = RegExp(r'\.(mp4|m4v|mov|m4a|mkv|webm|mp3|aac|ogg|opus|flac|wav|ts|m3u8)$', caseSensitive: false);
  static const maxPlaylist = 200;
  HlsConcatServer? _hls; // сервер склейки HLS текущего ролика

  static bool isDirect(Uri uri) => _direct.hasMatch(uri.path);

  @override
  Future<List<LinkInfo>> inspect(String raw) async {
    final text = raw.trim();
    final uri = Uri.tryParse(text);
    if (uri == null || !uri.hasScheme || !(uri.scheme == 'http' || uri.scheme == 'https')) throw UnsupportedLink('Вставьте полную ссылку с http:// или https://');
    final host = uri.host.toLowerCase();
    if (host.contains('youtube.com') || host.contains('youtu.be')) return _youtube(text, uri);
    if (isDirect(uri)) return [await _directInfo(uri)];
    throw UnsupportedLink('Эту ссылку без ПК не разобрать: она уйдёт на ПК при подключении. Сами по себе работают YouTube и прямые ссылки на видео и звук (mp4, mkv, webm, mp3, m3u8).', sendToPc: true);
  }

  Future<List<LinkInfo>> _youtube(String text, Uri uri) async {
    final yt = YoutubeExplode();
    try {
      final videoId = VideoId.parseVideoId(text);
      final listId = PlaylistId.parsePlaylistId(text);
      // Ссылка на страницу плейлиста (или нет отдельного видео) — берём весь плейлист; видео из плейлиста — одно видео.
      if (listId != null && (videoId == null || uri.path == '/playlist')) {
        final videos = await playlistVideos(listId);
        if (videos.isEmpty) throw UnsupportedLink('Плейлист пуст или закрыт');
        return videos;
      }
      if (videoId == null) throw UnsupportedLink('Не получилось понять ссылку на YouTube');
      final video = await yt.videos.get(VideoId(videoId));
      if (video.isLive) throw UnsupportedLink('Прямые трансляции без ПК не поддерживаются: ссылка уйдёт на ПК при подключении', sendToPc: true);
      return [_fromVideo(video)];
    } on UnsupportedLink {
      rethrow;
    } on VideoUnavailableException catch (e) {
      throw UnsupportedLink('Видео недоступно: ${e.message}');
    } catch (e) {
      throw UnsupportedLink('Не удалось получить видео с YouTube. Проверьте интернет. ($e)');
    } finally {
      yt.close();
    }
  }

  /// Видео плейлиста. Библиотека читает старый ответ YouTube и на новом отдаёт пусто, поэтому спрашиваем напрямую
  /// (запрос, которым пользуется сама страница просмотра): в нём названия, длительность и обложки сразу.
  static Future<List<LinkInfo>> playlistVideos(String listId, {Uri? endpoint}) async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 12);
    try {
      final request = await client.postUrl(endpoint ?? Uri.parse('https://www.youtube.com/youtubei/v1/next?prettyPrint=false'));
      request.headers
        ..contentType = ContentType.json
        ..set(HttpHeaders.userAgentHeader, 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36')
        ..set('origin', 'https://www.youtube.com');
      request.write(jsonEncode({
        'context': {'client': {'clientName': 'WEB', 'clientVersion': '2.20251001.00.00', 'hl': 'ru', 'gl': 'US'}},
        'playlistId': listId,
      }));
      final response = await request.close().timeout(const Duration(seconds: 20));
      final body = await utf8.decodeStream(response);
      if (response.statusCode != 200) throw UnsupportedLink('YouTube ответил ${response.statusCode}');
      return parsePlaylist(jsonDecode(body));
    } on UnsupportedLink {
      rethrow;
    } catch (e) {
      throw UnsupportedLink('Не удалось получить плейлист. Проверьте интернет. ($e)');
    } finally {
      client.close(force: true);
    }
  }

  /// Достаёт видео из ответа YouTube (элементы playlistPanelVideoRenderer в любом месте дерева).
  static List<LinkInfo> parsePlaylist(Object? json) {
    final out = <LinkInfo>[];
    void walk(Object? node) {
      if (out.length >= maxPlaylist) return;
      if (node is Map) {
        final video = node['playlistPanelVideoRenderer'];
        if (video is Map && video['videoId'] is String) {
          final id = video['videoId'] as String;
          String text(Object? value) => value is Map ? '${value['simpleText'] ?? ((value['runs'] as List?)?.map((r) => r['text']).join() ?? '')}' : '';
          final thumbs = (video['thumbnail']?['thumbnails'] as List?) ?? const [];
          out.add(LinkInfo(
            url: 'https://www.youtube.com/watch?v=$id',
            title: text(video['title']).isEmpty ? id : text(video['title']),
            duration: _clock(text(video['lengthText'])),
            thumbnail: 'https://i.ytimg.com/vi/$id/hqdefault.jpg',
            kind: 'youtube',
            sourceId: id,
          ));
          if (thumbs.isEmpty) return;
          return;
        }
        for (final value in node.values) {
          walk(value);
        }
      } else if (node is List) {
        for (final value in node) {
          walk(value);
        }
      }
    }

    walk(json);
    return out;
  }

  static double _clock(String text) {
    final parts = text.split(':').map(int.tryParse).toList();
    if (parts.isEmpty || parts.contains(null)) return 0;
    return parts.fold<int>(0, (total, part) => total * 60 + part!).toDouble();
  }

  static LinkInfo _fromVideo(Video video) => LinkInfo(
        url: 'https://www.youtube.com/watch?v=${video.id.value}',
        title: video.title,
        duration: video.duration?.inMilliseconds == null ? 0 : video.duration!.inMilliseconds / 1000,
        thumbnail: 'https://i.ytimg.com/vi/${video.id.value}/hqdefault.jpg',
        kind: 'youtube',
        sourceId: video.id.value,
      );

  Future<LinkInfo> _directInfo(Uri uri) async {
    final name = uri.pathSegments.isEmpty || uri.pathSegments.last.isEmpty ? uri.host : uri.pathSegments.last; // сегменты уже раскодированы
    if (_m3u8.hasMatch(uri.path)) {
      try {
        final playlist = await loadHls(uri);
        return LinkInfo(url: uri.toString(), title: name, duration: playlist.duration, thumbnail: '', kind: 'direct');
      } on HlsUnsupported catch (e) {
        throw UnsupportedLink('${e.message}. Ссылка уйдёт на ПК при подключении', sendToPc: true);
      } catch (e) {
        throw UnsupportedLink('Не удалось открыть ссылку: $e');
      }
    }
    if (!_mp4.hasMatch(uri.path)) return LinkInfo(url: uri.toString(), title: name, duration: 0, thumbnail: '', kind: 'direct');
    final source = HttpSource(uri);
    try {
      final info = await readMp4From(source);
      return LinkInfo(url: uri.toString(), title: name, duration: info.duration, thumbnail: '', kind: 'direct');
    } on Mp4Unsupported {
      // Кодеки не для отправки как есть (например HEVC): эфир перекодирует телефон.
      return LinkInfo(url: uri.toString(), title: name, duration: 0, thumbnail: '', kind: 'direct');
    } catch (e) {
      throw UnsupportedLink('Не удалось открыть ссылку: $e');
    } finally {
      await source.close();
    }
  }

  /// Картинка и звук отдельно, до [maxHeight]: H.264 предпочтительнее (его телефоны декодируют аппаратно), VP9 — до 720p.
  @override
  Future<EngineSource> engineSource(SharedFile item, {required int maxHeight}) async {
    if (item.kind != 'youtube') {
      final uri = Uri.tryParse(item.url);
      if (uri == null || !_m3u8.hasMatch(uri.path)) return EngineSource(video: item.url);
      // MediaExtractor плейлисты не читает: склеиваем сегменты в один поток на локальном адресе.
      try {
        final server = await HlsConcatServer.start(await loadHls(uri, maxHeight: maxHeight));
        await _hls?.close();
        _hls = server;
        return EngineSource(video: server.url.toString());
      } on HlsUnsupported catch (e) {
        throw UnsupportedLink(e.message);
      }
    }
    final yt = YoutubeExplode();
    try {
      final manifest = await yt.videos.streamsClient.getManifest(VideoId(item.sourceId));
      final pick = pickYoutubeStreams(
        [for (final s in manifest.videoOnly) (url: s.url.toString(), codec: s.videoCodec, height: s.videoResolution.height, bitrate: s.bitrate.bitsPerSecond)],
        [for (final s in manifest.audioOnly) (url: s.url.toString(), codec: s.audioCodec, bitrate: s.bitrate.bitsPerSecond)],
        maxHeight,
      );
      if (pick.video == null) {
        // Раздельных потоков нет — берём готовый (картинка со звуком в одном файле).
        final muxed = manifest.muxed.toList()..sort((a, b) => a.videoQuality.index.compareTo(b.videoQuality.index));
        if (muxed.isEmpty) throw UnsupportedLink('У этого видео нет доступного потока');
        return EngineSource(video: muxed.last.url.toString());
      }
      return pick;
    } on UnsupportedLink {
      rethrow;
    } catch (e) {
      throw UnsupportedLink('Не удалось получить поток YouTube: $e');
    } finally {
      yt.close();
    }
  }

  /// Выбор потоков YouTube. Вынесен отдельно, чтобы проверять без сети.
  static EngineSource pickYoutubeStreams(
    List<({String url, String codec, int height, int bitrate})> videos,
    List<({String url, String codec, int bitrate})> audios,
    int maxHeight,
  ) {
    String? video;
    final inLimit = videos.where((v) => v.height <= maxHeight).toList();
    int better(({String url, String codec, int height, int bitrate}) a, ({String url, String codec, int height, int bitrate}) b) =>
        a.height != b.height ? a.height.compareTo(b.height) : a.bitrate.compareTo(b.bitrate);
    final h264 = inLimit.where((v) => v.codec.startsWith('avc1')).toList()..sort(better);
    final vp9 = inLimit.where((v) => v.codec.startsWith('vp9') && v.height <= 720).toList()..sort(better);
    if (h264.isNotEmpty) {
      video = h264.last.url;
    } else if (vp9.isNotEmpty) {
      video = vp9.last.url;
    } else if (videos.isNotEmpty) {
      // Ничего нет в пределах лимита: берём самый маленький, при равенстве — H.264.
      int avc(({String url, String codec, int height, int bitrate}) v) => v.codec.startsWith('avc1') ? 0 : 1;
      final lowest = [...videos]..sort((a, b) => a.height != b.height ? a.height.compareTo(b.height) : avc(a).compareTo(avc(b)));
      video = lowest.first.url;
    }
    final aac = audios.where((a) => a.codec.startsWith('mp4a')).toList()..sort((a, b) => a.bitrate.compareTo(b.bitrate));
    final any = [...audios]..sort((a, b) => a.bitrate.compareTo(b.bitrate));
    final audio = aac.isNotEmpty ? aac.last.url : any.isNotEmpty ? any.last.url : null;
    return EngineSource(video: video, audio: audio);
  }

  @override
  Future<ByteSource> open(SharedFile item) async {
    if (item.kind != 'youtube') return HttpSource(Uri.parse(item.url));
    final yt = YoutubeExplode();
    try {
      final manifest = await yt.videos.streamsClient.getManifest(VideoId(item.sourceId));
      // Готовый mp4 с картинкой H.264 и звуком AAC: его можно отдавать на сервер без перекодирования.
      final options = manifest.muxed.where((s) => s.container.name == 'mp4' && s.videoCodec.startsWith('avc1') && s.audioCodec.startsWith('mp4a')).toList()
        ..sort((a, b) => a.videoQuality.index.compareTo(b.videoQuality.index));
      if (options.isEmpty) throw UnsupportedLink('У этого видео нет совместимого потока без ПК');
      return HttpSource(options.last.url);
    } on UnsupportedLink {
      rethrow;
    } catch (e) {
      throw UnsupportedLink('Не удалось получить поток YouTube: $e');
    } finally {
      yt.close();
    }
  }
}
