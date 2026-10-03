import 'dart:convert';
import 'dart:io';

import 'package:youtube_explode_dart/youtube_explode_dart.dart';

import 'byte_source.dart';
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

class DefaultLinkResolver implements LinkResolver {
  static final _direct = RegExp(r'\.(mp4|m4v|mov|m4a)$', caseSensitive: false);
  static const maxPlaylist = 200;

  static bool isDirect(Uri uri) => _direct.hasMatch(uri.path);

  @override
  Future<List<LinkInfo>> inspect(String raw) async {
    final text = raw.trim();
    final uri = Uri.tryParse(text);
    if (uri == null || !uri.hasScheme || !(uri.scheme == 'http' || uri.scheme == 'https')) throw UnsupportedLink('Вставьте полную ссылку с http:// или https://');
    final host = uri.host.toLowerCase();
    if (host.contains('youtube.com') || host.contains('youtu.be')) return _youtube(text, uri);
    if (isDirect(uri)) return [await _directInfo(uri)];
    throw UnsupportedLink('Эту ссылку без ПК не разобрать: она уйдёт на ПК при подключении. Сами по себе работают YouTube и прямые ссылки на mp4.', sendToPc: true);
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
    final source = HttpSource(uri);
    try {
      final info = await readMp4From(source);
      final name = uri.pathSegments.isEmpty || uri.pathSegments.last.isEmpty ? uri.host : uri.pathSegments.last; // сегменты уже раскодированы
      return LinkInfo(url: uri.toString(), title: name, duration: info.duration, thumbnail: '', kind: 'direct');
    } on Mp4Unsupported catch (e) {
      throw UnsupportedLink('${e.message}. Ссылка уйдёт на ПК при подключении', sendToPc: true);
    } catch (e) {
      throw UnsupportedLink('Не удалось открыть ссылку: $e');
    } finally {
      await source.close();
    }
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
