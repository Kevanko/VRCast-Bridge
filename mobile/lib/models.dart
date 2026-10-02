/// Состояние сервера VRCast Bridge, разобранное из /api/status (и /api/events).
class QueueItem {
  QueueItem({required this.id, required this.title, required this.duration, required this.thumbnail, required this.unavailable});

  final String id;
  final String title;
  final double duration;
  final String thumbnail;
  final bool unavailable;

  factory QueueItem.fromJson(Map<String, dynamic> json) => QueueItem(
        id: '${json['id']}',
        title: '${json['title'] ?? ''}',
        duration: (json['duration'] as num?)?.toDouble() ?? 0,
        thumbnail: '${json['thumbnail'] ?? ''}',
        unavailable: json['unavailable'] == true,
      );
}

class ServerChoice {
  ServerChoice(this.id, this.name, this.reachable);
  final String id;
  final String name;
  final bool? reachable;
}

class BridgeState {
  BridgeState({
    required this.running,
    required this.activeKind,
    required this.currentId,
    required this.queue,
    required this.elapsed,
    required this.duration,
    required this.paused,
    required this.buffering,
    required this.busy,
    required this.canSeek,
    required this.speed,
    required this.loopMode,
    required this.mediaVolume,
    required this.streamReady,
    required this.playbackUrl,
    required this.rtspLanUrls,
    required this.tunnelUrl,
    required this.tunnelState,
    required this.statusLabel,
    required this.phoneSource,
    required this.outputMode,
    required this.tunnelProvider,
    required this.quality,
    required this.fps,
    required this.encoderMode,
    required this.activeServerId,
    required this.whiteIp,
    required this.servers,
    required this.profileQuality,
    required this.profileFps,
    required this.profileBitrateKbps,
    required this.encoderLabel,
    required this.pendingProfile,
    required this.deliveryPhase,
    required this.deliveryReady,
    required this.deliveryError,
    DateTime? receivedAt,
  }) : receivedAt = receivedAt ?? DateTime.now();

  final bool running;
  final String activeKind; // 'queue' | 'screen' | ''
  final String currentId;
  final List<QueueItem> queue;
  final double elapsed;
  final double duration;
  final bool paused;
  final bool buffering;
  final bool busy;
  final bool canSeek;
  final double speed;
  final String loopMode;
  final double mediaVolume;
  final bool streamReady;
  final String playbackUrl;
  final List<String> rtspLanUrls;
  final String tunnelUrl;
  final String tunnelState;
  final String statusLabel;
  final bool phoneSource;
  final String outputMode; // local | tunnel | remote
  final String tunnelProvider;
  final String quality;
  final int fps;
  final String encoderMode;
  final String activeServerId;
  final String whiteIp;
  final List<ServerChoice> servers;
  // Профиль, в котором ПК реально ведёт эфир (с учётом авто-снижения), а не только выбранный в настройках.
  final String profileQuality;
  final int profileFps;
  final int profileBitrateKbps;
  final String encoderLabel;
  final String pendingProfile; // что применится при следующем запуске, если оно отличается от текущего, иначе пусто
  final String deliveryPhase;
  final bool deliveryReady;
  final String deliveryError;
  final DateTime receivedAt;

  QueueItem? get current {
    for (final item in queue) {
      if (item.id == currentId) return item;
    }
    return null;
  }

  bool get isScreen => activeKind == 'screen';
  bool get isPlaying => running && !paused && !buffering;

  /// Позиция сейчас: между событиями сервера двигаем её по своим часам.
  double positionAt(DateTime now) {
    if (!isPlaying || activeKind != 'queue') return elapsed;
    final value = elapsed + now.difference(receivedAt).inMilliseconds / 1000 * speed;
    return duration > 0 ? value.clamp(0, duration).toDouble() : value;
  }

  factory BridgeState.fromJson(Map<String, dynamic> json) {
    final progress = (json['progress'] as Map?)?.cast<String, dynamic>() ?? const {};
    final playback = (json['playback'] as Map?)?.cast<String, dynamic>() ?? const {};
    final stream = (json['stream'] as Map?)?.cast<String, dynamic>() ?? const {};
    final config = (json['config'] as Map?)?.cast<String, dynamic>() ?? const {};
    final rtsp = (json['rtsp'] as Map?)?.cast<String, dynamic>() ?? const {};
    final tunnel = (json['tunnel'] as Map?)?.cast<String, dynamic>() ?? const {};
    final performance = (json['performance'] as Map?)?.cast<String, dynamic>() ?? const {};
    final profile = (performance['outputProfile'] as Map?)?.cast<String, dynamic>() ?? const {};
    final delivery = (json['delivery'] as Map?)?.cast<String, dynamic>() ?? const {};
    final desired = (performance['desiredProfile'] as Map?)?.cast<String, dynamic>() ?? const {};
    final running = json['running'] == true;
    final paused = playback['paused'] == true;
    final buffering = playback['buffering'] == true;
    return BridgeState(
      running: running,
      activeKind: '${json['activeKind'] ?? ''}',
      currentId: '${json['currentId'] ?? ''}',
      queue: [for (final item in (json['queue'] as List? ?? const [])) QueueItem.fromJson((item as Map).cast<String, dynamic>())],
      elapsed: (progress['elapsed'] as num?)?.toDouble() ?? 0,
      duration: (progress['duration'] as num?)?.toDouble() ?? 0,
      paused: paused,
      buffering: buffering,
      busy: playback['busy'] == true,
      canSeek: playback['canSeek'] == true,
      speed: (playback['speed'] as num?)?.toDouble() ?? 1,
      loopMode: '${playback['loopMode'] ?? 'once'}',
      mediaVolume: (config['mediaVolume'] as num?)?.toDouble() ?? 1,
      streamReady: stream['ready'] == true,
      playbackUrl: '${json['playbackUrl'] ?? ''}',
      rtspLanUrls: [for (final url in (rtsp['lanUrls'] as List? ?? const [])) '$url'],
      tunnelUrl: '${tunnel['url'] ?? ''}',
      tunnelState: '${tunnel['state'] ?? ''}',
      phoneSource: json['phoneSource'] == true,
      outputMode: '${config['outputMode'] ?? 'local'}',
      tunnelProvider: '${config['tunnelProvider'] ?? 'auto'}',
      quality: '${config['quality'] ?? '720p'}',
      fps: (config['fps'] as num?)?.toInt() ?? 30,
      encoderMode: '${config['encoderMode'] ?? 'auto'}',
      activeServerId: '${config['activeServerId'] ?? ''}',
      whiteIp: '${config['whiteIp'] ?? ''}',
      profileQuality: '${profile['quality'] ?? config['quality'] ?? '720p'}',
      profileFps: (profile['fps'] as num?)?.toInt() ?? (config['fps'] as num?)?.toInt() ?? 30,
      profileBitrateKbps: (profile['bitrateKbps'] as num?)?.toInt() ?? 0,
      encoderLabel: '${performance['encoder'] ?? ''}',
      pendingProfile: performance['pendingProfile'] == true && desired.isNotEmpty
          ? '${desired['quality']} · ${desired['fps']} к/с'
          : '',
      deliveryPhase: '${delivery['phase'] ?? ''}',
      deliveryReady: delivery['ready'] == true,
      deliveryError: '${delivery['error'] ?? ''}',
      servers: [
        for (final item in (config['servers'] as List? ?? const []))
          ServerChoice('${(item as Map)['id']}', '${item['name'] ?? item['id']}', item['reachable'] as bool?),
      ],
      statusLabel: !running
          ? 'Эфир остановлен'
          : buffering
              ? 'Буферизация…'
              : paused
                  ? 'Пауза'
                  : json['phoneSource'] == true
                      ? 'Идёт экран телефона'
                      : json['activeKind'] == 'screen'
                          ? 'Идёт захват экрана'
                      : 'Идёт эфир',
    );
  }
}

String formatTime(double seconds) {
  final total = seconds.isFinite && seconds > 0 ? seconds.floor() : 0;
  final h = total ~/ 3600, m = (total % 3600) ~/ 60, s = total % 60;
  String two(int v) => v.toString().padLeft(2, '0');
  return h > 0 ? '$h:${two(m)}:${two(s)}' : '$m:${two(s)}';
}
