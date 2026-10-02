import 'dart:async';

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'media_server.dart';
import 'models.dart';
import 'own_server.dart';
import 'phone_stream.dart';

enum Link { idle, connecting, online, offline }

/// Соединение с одним ПК: живое состояние по SSE и команды.
class Remote extends ChangeNotifier {
  Remote(this.api, {this.pcName = '', PhoneStream? phone, MediaServer? media})
      : isLocal = false,
        phone = phone ?? PhoneStream(),
        media = media ?? MediaServer(files: () => Prefs.instance.sharedFiles) {
    _listenPhone();
  }

  /// Без ПК: приложение работает от своих данных (последняя копия очереди и настроек ПК, свои серверы).
  /// Подключение к ПК потом ничего не ломает: данные синхронизируются в обе стороны.
  Remote.local({PhoneStream? phone})
      : api = Api(Uri.parse('http://127.0.0.1:1')),
        pcName = '',
        isLocal = true,
        media = MediaServer(files: () => Prefs.instance.sharedFiles),
        phone = phone ?? PhoneStream() {
    _listenPhone();
    final cached = Prefs.instance.cachedState;
    try {
      state = BridgeState.offlineFrom(cached == null ? <String, dynamic>{} : (jsonDecode(cached) as Map).cast<String, dynamic>());
    } catch (_) {
      state = BridgeState.offlineFrom(const {});
    }
    link = Link.offline;
  }

  final Api api;
  final String pcName;
  final bool isLocal;
  final MediaServer media; // отдаёт файлы этого телефона в общую очередь
  bool _phoneViaPc = false;
  bool needsPin = false; // ПК закрыт PIN-кодом, ключа у телефона нет
  String myId = ''; // номер этого телефона в группе на ПК

  bool get online => link == Link.online;

  void _listenPhone() => _phoneSub = phone.changes.listen((_) => notifyListeners());
  BridgeState? state;
  Link link = Link.idle;
  String? error;
  bool _closed = false;
  Timer? _tick;
  final PhoneStream phone;
  bool _synced = false;
  bool _contributing = false;
  int _seenRevision = 0;
  Timer? _shareTimer;
  StreamSubscription<void>? _phoneSub;

  /// Подключаемся и держим соединение: при обрыве пробуем снова.
  void start() {
    if (isLocal || link != Link.idle) return;
    Prefs.instance.addListener(_prefsChanged);
    _loop();
    _tick = Timer.periodic(const Duration(milliseconds: 500), (_) {
      if (state?.isPlaying == true) notifyListeners();
    });
  }

  Future<void> _loop() async {
    var delay = 1;
    while (!_closed) {
      link = state == null ? Link.connecting : Link.offline;
      notifyListeners();
      try {
        var first = true; // новое соединение приняли — значит ключ верный; на лету просьбу о PIN события не сбрасывают
        await for (final next in api.events()) {
          if (_closed) return;
          if (first) { needsPin = false; first = false; }
          state = next; link = Link.online; error = null; delay = 1;
          // ПК остановил эфир с телефона (или он оборвался) — выключаем и запись экрана.
          final since = phone.startedAt;
          if (phone.live && !next.phoneSource && since != null && DateTime.now().difference(since).inSeconds > 8) phone.stop();
          Prefs.instance.cacheState(next.json);
          if (!_synced) { _synced = true; syncAll(); }
          Prefs.instance.mirrorProfile(next.profileQuality, next.profileFps);
          // Качество, частоту кадров и битрейт отправки берём из профиля ПК: поменяли там — телефон подстроился.
          if (phone.live) phone.applyProfile(quality: next.profileQuality, fps: next.profileFps, bitrateKbps: next.profileBitrateKbps);
          notifyListeners();
        }
      } catch (e) {
        error = '$e';
        if (e is ApiException && e.code == 'pin' && !needsPin) {
          needsPin = true;
          notifyListeners();
        }
      }
      if (_closed) return;
      link = Link.offline;
      notifyListeners();
      await Future<void>.delayed(Duration(seconds: delay));
      delay = delay < 8 ? delay * 2 : 8;
    }
  }

  /// Команда: ошибку показываем, а состояние придёт событием.
  Future<String?> run(Future<void> Function() action) async {
    if (!online) return 'Нет связи с ПК. Подключитесь к ПК, чтобы управлять эфиром.';
    try {
      await action();
      return null;
    } catch (e) {
      // Устройство отвязали на ПК или сменили PIN: ключ больше не годится — просим ввести PIN заново.
      if (e is ApiException && e.code == 'pin' && !needsPin) {
        needsPin = true;
        notifyListeners();
      }
      return '$e';
    }
  }

  Future<String?> playback(String action, [Map<String, Object?> extra = const {}]) => run(() => api.playback(action, extra));

  /// При подключении: накопленные без связи ссылки уходят в очередь ПК, а свои файлы и серверы
  /// становятся видны всей группе (пока телефон подключён).
  Future<void> syncAll() async {
    await pushPendingLinks();
    if (api.token != null) {
      try { myId = await api.myId(); } catch (_) {}
    }
    await contribute();
  }

  // Файлы или серверы поменялись — группа должна узнать об этом сразу, а не при следующем подключении.
  void _prefsChanged() {
    if (Prefs.instance.shareRevision == _seenRevision || !online) return;
    _shareTimer?.cancel();
    _shareTimer = Timer(const Duration(milliseconds: 300), contribute);
  }

  /// Отдать группе свои файлы и серверы. ПК в ответ сообщает, какие файлы другие убрали из общей очереди, —
  /// у себя убираем их тоже.
  Future<void> contribute() async {
    final prefs = Prefs.instance;
    if (isLocal || !online || api.token == null || _contributing) return;
    _contributing = true;
    try {
      final port = await media.start(port: prefs.mediaPort);
      var base = prefs.mediaAddress.isEmpty ? null : 'http://${prefs.mediaAddress}';
      if (base == null) {
        final address = await localAddressFor(api.base.host);
        if (address == null) return;
        base = 'http://$address:$port';
      }
      final revision = prefs.shareRevision;
      final removed = await api.contribute(
        mediaBase: base,
        mediaKey: media.key,
        files: [for (final file in prefs.sharedFiles) {'id': file.id, 'title': file.title}],
        servers: prefs.ownServers,
      );
      _seenRevision = revision;
      if (removed.isNotEmpty) prefs.dropSharedFiles(removed);
    } catch (_) {
      _synced = false; // не дошло — повторим с ближайшим событием
    } finally {
      _contributing = false;
    }
  }

  /// Перехватить эфир: дальше его ведёт это устройство.
  Future<String?> takeLead() => run(api.take);

  /// Ссылки, добавленные без связи, отправляем в очередь ПК; что не ушло, остаётся ждать.
  Future<int> pushPendingLinks() async {
    var sent = 0;
    for (final url in [...Prefs.instance.pendingLinks]) {
      try {
        await api.addLink(url, confirm: true);
        Prefs.instance.removePendingLink(url);
        sent++;
      } catch (_) {
        break;
      }
    }
    if (sent > 0) notifyListeners();
    return sent;
  }

  /// PIN введён: получаем ключ, дальше соединение переустанавливается само.
  void acceptToken(String token) {
    api.token = token;
    Prefs.instance.setToken(api.base.toString(), token);
    needsPin = false;
    _synced = false;
    notifyListeners();
  }

  /// Куда пойдёт экран телефона: через ПК (он есть и на связи) или напрямую на свой сервер.
  String get streamTarget {
    if (online) return 'через ПК';
    final server = Prefs.instance.currentOwnServer;
    return server == null ? '' : 'на сервер «${server.name}»';
  }

  /// Экран телефона в эфир: через ПК, если он на связи, иначе прямо на свой сервер. Режима переключать не нужно.
  Future<String?> startPhoneBroadcast() async {
    if (!online) {
      final server = Prefs.instance.currentOwnServer;
      if (server == null) return 'ПК не на связи, и своего сервера нет. Добавьте сервер в настройках или подключитесь к ПК.';
      try {
        _phoneViaPc = false;
        await phone.startDirect(server, quality: Prefs.instance.standaloneQuality, fps: Prefs.instance.standaloneFps);
        notifyListeners();
        return null;
      } catch (e) {
        await phone.stop();
        return '$e';
      }
    }
    _phoneViaPc = true;
    try {
      final info = await api.lanInfo();
      final s = state;
      await phone.start(api.base, (info['webrtcPort'] as num).toInt(),
          quality: s?.profileQuality ?? '720p', fps: s?.profileFps ?? 30, bitrateKbps: s?.profileBitrateKbps ?? 0);
      await api.startPhone();
      notifyListeners();
      return null;
    } catch (e) {
      await phone.stop();
      return '$e';
    }
  }

  Future<String?> stopPhoneBroadcast() async {
    await phone.stop();
    return _phoneViaPc && online ? run(api.stop) : null;
  }

  @override
  void dispose() {
    Prefs.instance.removeListener(_prefsChanged);
    _shareTimer?.cancel();
    media.stop();
    phone.stop();
    _phoneSub?.cancel();
    _closed = true;
    _tick?.cancel();
    api.close();
    super.dispose();
  }
}

class SavedPc {
  SavedPc(this.name, this.url);
  final String name;
  final String url;
  Uri get base => Uri.parse(url);
  @override
  bool operator ==(Object other) => other is SavedPc && other.url == url;
  @override
  int get hashCode => url.hashCode;
}

/// Настройки приложения и запомненные компьютеры.
class Prefs extends ChangeNotifier {
  static final Prefs instance = Prefs();

  bool autoConnect = true;
  bool preview = true;
  int defaultPort = 4717;
  List<SavedPc> pcs = [];
  SavedPc? last;
  Map<String, String> tokens = {}; // адрес ПК → ключ привязки
  // Работа без ПК: свои серверы и качество, которое подхватывается с ПК, когда он есть.
  // Что накоплено без связи: ссылки уйдут в очередь ПК при подключении; последнее состояние ПК — для показа без связи.
  List<String> pendingLinks = [];
  // Как называется этот телефон (его видит ПК в списке устройств) и свои имена для найденных устройств.
  String deviceName = 'Телефон';
  Map<String, String> aliases = {};
  String? cachedState;
  List<OwnServer> ownServers = [];
  String? ownServerId;
  // Файлы этого телефона, которые он отдаёт в общую очередь, пока подключён. shareRevision растёт при любой правке файлов и серверов.
  List<SharedFile> sharedFiles = [];
  int shareRevision = 0;
  // Для проверки на эмуляторе, где адрес телефона не виден ПК: «адрес:порт», который назвать ПК, и порт сервера файлов.
  String mediaAddress = '';
  int mediaPort = 0;
  String standaloneQuality = '720p';
  int standaloneFps = 30;

  Future<void> load() async {
    final p = await SharedPreferences.getInstance();
    autoConnect = p.getBool('autoConnect') ?? true;
    preview = p.getBool('preview') ?? true;
    defaultPort = p.getInt('defaultPort') ?? 4717;
    pcs = [for (final raw in p.getStringList('pcs') ?? const []) if (raw.contains('\n')) SavedPc(raw.split('\n').first, raw.split('\n').last)];
    tokens = {for (final raw in p.getStringList('tokens') ?? const []) if (raw.contains('\n')) raw.split('\n').first: raw.split('\n').last};
    ownServers = [for (final raw in p.getStringList('ownServers') ?? const []) OwnServer.fromJson((jsonDecode(raw) as Map).cast<String, dynamic>())];
    ownServerId = p.getString('ownServerId');
    sharedFiles = [for (final raw in p.getStringList('sharedFiles') ?? const []) SharedFile.fromJson((jsonDecode(raw) as Map).cast<String, dynamic>())];
    mediaAddress = p.getString('mediaAddress') ?? '';
    mediaPort = p.getInt('mediaPort') ?? 0;
    pendingLinks = p.getStringList('pendingLinks') ?? [];
    deviceName = p.getString('deviceName') ?? 'Телефон';
    aliases = {for (final raw in p.getStringList('aliases') ?? const []) if (raw.contains('\n')) raw.split('\n').first: raw.split('\n').last};
    cachedState = p.getString('cachedState');
    standaloneQuality = p.getString('standaloneQuality') ?? '720p';
    standaloneFps = p.getInt('standaloneFps') ?? 30;
    final l = p.getStringList('lastPc');
    last = l != null && l.length == 2 ? SavedPc(l[0], l[1]) : null;
    notifyListeners();
  }

  Future<void> _save() async {
    final p = await SharedPreferences.getInstance();
    await p.setBool('autoConnect', autoConnect);
    await p.setBool('preview', preview);
    await p.setInt('defaultPort', defaultPort);
    await p.setStringList('ownServers', [for (final s in ownServers) jsonEncode(s.toJson())]);
    ownServerId == null ? await p.remove('ownServerId') : await p.setString('ownServerId', ownServerId!);
    await p.setStringList('sharedFiles', [for (final f in sharedFiles) jsonEncode(f.toJson())]);
    await p.setStringList('pendingLinks', pendingLinks);
    await p.setString('deviceName', deviceName);
    await p.setStringList('aliases', [for (final e in aliases.entries) '${e.key}\n${e.value}']);
    cachedState == null ? await p.remove('cachedState') : await p.setString('cachedState', cachedState!);
    await p.setString('standaloneQuality', standaloneQuality);
    await p.setInt('standaloneFps', standaloneFps);
    await p.setStringList('tokens', [for (final e in tokens.entries) '${e.key}\n${e.value}']);
    await p.setStringList('pcs', [for (final pc in pcs) '${pc.name}\n${pc.url}']);
    last == null ? await p.remove('lastPc') : await p.setStringList('lastPc', [last!.name, last!.url]);
  }

  void update(void Function() change) {
    change();
    notifyListeners();
    _save();
  }

  void remember(String name, String url) => update(() {
        final pc = SavedPc(name, url);
        pcs = [pc, ...pcs.where((e) => e != pc)].take(10).toList();
        last = pc;
      });

  void forget(SavedPc pc) => update(() {
        pcs = pcs.where((e) => e != pc).toList();
        if (last == pc) last = null;
      });

  void leave() => update(() => last = null);

  /// Имя устройства: своё, если задали, иначе то, что назвал сам ПК.
  String nameFor(String authority, String fallback) {
    final alias = aliases[authority];
    return alias == null || alias.trim().isEmpty ? fallback : alias;
  }

  void setAlias(String authority, String? name) => update(() {
        final value = name?.trim() ?? '';
        value.isEmpty ? aliases.remove(authority) : aliases[authority] = value.length > 40 ? value.substring(0, 40) : value;
      });

  void setDeviceName(String name) => update(() => deviceName = name.trim().isEmpty ? 'Телефон' : name.trim());

  void addPendingLink(String url) => update(() {
        if (!pendingLinks.contains(url)) pendingLinks = [...pendingLinks, url];
      });

  void removePendingLink(String url) => update(() => pendingLinks = pendingLinks.where((e) => e != url).toList());

  /// Локальная копия состояния ПК; пишем только когда изменилось то, что видно без связи.
  void cacheState(Map<String, dynamic> json) {
    // Только то, что меняется редко: ход воспроизведения и таймеры в копию не попадают, иначе запись шла бы каждую секунду.
    final performance = (json['performance'] as Map?) ?? const {};
    final trimmed = <String, dynamic>{
      for (final key in const ['queue', 'config', 'rtsp', 'playbackUrl'])
        if (json.containsKey(key)) key: json[key],
      'performance': {for (final key in const ['encoder', 'outputProfile', 'desiredProfile']) if (performance.containsKey(key)) key: performance[key]},
    };
    (trimmed['config'] as Map?)?.remove('pairedPhones');
    (trimmed['config'] as Map?)?.remove('accessPin');
    (trimmed['rtsp'] as Map?)?.remove('remote');
    final encoded = jsonEncode(trimmed);
    if (encoded == cachedState) return;
    cachedState = encoded;
    _save();
  }

  OwnServer? get currentOwnServer {
    for (final s in ownServers) {
      if (s.id == ownServerId) return s;
    }
    return ownServers.isEmpty ? null : ownServers.first;
  }

  /// Добавить или обновить свой сервер (по адресу и порту) и выбрать его.
  void saveOwnServer(OwnServer server) => update(() {
        ownServers = [server, ...ownServers.where((e) => e.id != server.id)];
        ownServerId = server.id;
        shareRevision++;
      });

  void removeOwnServer(OwnServer server) => update(() {
        ownServers = ownServers.where((e) => e.id != server.id).toList();
        if (ownServerId == server.id) ownServerId = null;
        shareRevision++;
      });

  void selectOwnServer(OwnServer server) => update(() => ownServerId = server.id);

  void setStandaloneProfile({String? quality, int? fps}) => update(() {
        standaloneQuality = quality ?? standaloneQuality;
        standaloneFps = fps ?? standaloneFps;
      });

  void addSharedFiles(List<SharedFile> files) => update(() {
        sharedFiles = [...sharedFiles, ...files];
        shareRevision++;
      });

  void removeSharedFile(String id) => dropSharedFiles([id]);

  /// Убрать файлы из общей очереди (сам убрал, либо их убрало другое устройство).
  void dropSharedFiles(List<String> ids) => update(() {
        sharedFiles = sharedFiles.where((f) => !ids.contains(f.id)).toList();
        shareRevision++;
      });

  /// Пока ПК рядом, качество для работы без ПК берём с него — переход между режимами без сюрпризов.
  void mirrorProfile(String quality, int fps) {
    if (quality == standaloneQuality && fps == standaloneFps) return;
    update(() { standaloneQuality = quality; standaloneFps = fps; });
  }

  void setToken(String pcUrl, String? token) => update(() => token == null ? tokens.remove(pcUrl) : tokens[pcUrl] = token);
}
