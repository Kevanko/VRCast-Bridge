import 'dart:async';

import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';
import 'package:video_player/video_player.dart';

import 'api.dart';
import 'discovery.dart';
import 'own_server.dart';
import 'models.dart';
import 'remote.dart';

const accent = Color(0xFF8B6BFF);

/// Что телефон узнаёт о ПК до подключения: его имя в сети и просит ли он PIN.
typedef DeviceProbe = Future<({String name, bool pinRequired})?> Function(Uri base);

Future<({String name, bool pinRequired})?> probeDevice(Uri base) async {
  try {
    final info = await Api(base).lanInfo().timeout(const Duration(seconds: 3));
    return (name: '${info['name'] ?? base.host}', pinRequired: info['pinRequired'] == true);
  } catch (_) {
    return null;
  }
}

/// Диалог ввода PIN ПК. Возвращает ключ привязки или null, если отменили.
Future<String?> pinDialog(BuildContext context, Api api, {required String title}) => showDialog<String>(
      context: context,
      builder: (_) => _PinDialog(api: api, title: title),
    );

class _PinDialog extends StatefulWidget {
  const _PinDialog({required this.api, required this.title});
  final Api api;
  final String title;
  @override
  State<_PinDialog> createState() => _PinDialogState();
}

class _PinDialogState extends State<_PinDialog> {
  final _pin = TextEditingController();
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _pin.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() { _busy = true; _error = null; });
    try {
      final token = await widget.api.pair(_pin.text, Prefs.instance.deviceName);
      if (mounted) Navigator.pop(context, token);
    } catch (e) {
      if (mounted) setState(() { _busy = false; _error = '$e'; });
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: Text(widget.title),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('Этот ПК защищён PIN-кодом. Введите его один раз — телефон запомнит.'),
          const SizedBox(height: 12),
          TextField(controller: _pin, autofocus: true, keyboardType: TextInputType.number, obscureText: true, maxLength: 8, onSubmitted: (_) => _submit(),
              decoration: const InputDecoration(labelText: 'PIN', border: OutlineInputBorder())),
          if (_error != null) Text(_error!, style: const TextStyle(color: Colors.redAccent)),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
          FilledButton(onPressed: _busy ? null : _submit, child: const Text('Войти')),
        ],
      );
}

/// Своё имя для устройства (ПК или телефона). Пустое — вернуть то, что назвало само устройство.
Future<String?> renameDialog(BuildContext context, String current, {String title = 'Имя устройства'}) =>
    showDialog<String>(context: context, builder: (_) => _RenameDialog(current: current, title: title));

class _RenameDialog extends StatefulWidget {
  const _RenameDialog({required this.current, required this.title});
  final String current;
  final String title;
  @override
  State<_RenameDialog> createState() => _RenameDialogState();
}

class _RenameDialogState extends State<_RenameDialog> {
  late final _controller = TextEditingController(text: widget.current);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: Text(widget.title),
        content: TextField(controller: _controller, autofocus: true, maxLength: 40, onSubmitted: (v) => Navigator.pop(context, v), decoration: const InputDecoration(border: OutlineInputBorder())),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
          FilledButton(onPressed: () => Navigator.pop(context, _controller.text), child: const Text('Сохранить')),
        ],
      );
}

/// Подключение к ПК: устройства в сети (с именами и замком, если нужен PIN), запомненные и ручной ввод.
class ConnectScreen extends StatefulWidget {
  const ConnectScreen({super.key, required this.onPick, this.onDisconnect, this.probe = probeDevice, this.discoveryFactory});
  final void Function(String name, Uri base) onPick;
  final VoidCallback? onDisconnect; // есть, пока подключены к ПК
  final DeviceProbe probe;
  final Discovery Function(void Function(List<FoundPc>) onChange)? discoveryFactory; // для тестов

  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen> {
  List<FoundPc> _found = const [];
  final Map<String, ({String name, bool pinRequired})?> _info = {};
  late Discovery _discovery;
  final _manual = TextEditingController();
  String? _error;

  @override
  void initState() {
    super.initState();
    _startSearch();
    for (final pc in Prefs.instance.pcs) { _probe(pc.base); }
  }

  void _startSearch() {
    _discovery = (widget.discoveryFactory ?? Discovery.new)((list) {
      if (!mounted) return;
      setState(() => _found = list);
      for (final pc in list) { _probe(pc.base); }
    });
    _discovery.start().catchError((Object e) => mounted ? setState(() => _error = 'Поиск в сети недоступен: $e') : null);
  }

  Future<void> _rescan() async {
    await _discovery.stop();
    if (mounted) setState(() { _found = const []; _info.clear(); });
    _startSearch();
  }

  Future<void> _probe(Uri base) async {
    if (_info.containsKey(base.authority)) return;
    _info[base.authority] = null;
    final info = await widget.probe(base);
    if (mounted) setState(() => _info[base.authority] = info);
  }

  @override
  void dispose() {
    _discovery.stop();
    _manual.dispose();
    super.dispose();
  }

  String _label(String authority, String fallback) => Prefs.instance.nameFor(authority, _info[authority]?.name ?? fallback);

  Future<void> _open(String name, Uri base) async {
    final authority = base.authority;
    final info = _info[authority] ?? await widget.probe(base);
    if (info?.pinRequired == true && Prefs.instance.tokens[base.toString()] == null) {
      if (!mounted) return;
      final token = await pinDialog(context, Api(base), title: Prefs.instance.nameFor(authority, info?.name ?? name));
      if (token == null) return;
      Prefs.instance.setToken(base.toString(), token);
    }
    widget.onPick(Prefs.instance.nameFor(authority, info?.name ?? name), base);
  }

  Future<void> _rename(String authority, String current) async {
    final name = await renameDialog(context, current);
    if (name != null) Prefs.instance.setAlias(authority, name);
    if (mounted) setState(() {});
  }

  Widget _device(IconData icon, String name, Uri base) {
    final authority = base.authority;
    final label = _label(authority, name);
    final locked = _info[authority]?.pinRequired == true;
    return Card(
      child: ListTile(
        leading: Icon(icon),
        title: Text(label),
        subtitle: Text(authority + (locked ? ' · нужен PIN' : '')),
        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
          if (locked) Icon(Prefs.instance.tokens[base.toString()] == null ? Icons.lock_outline : Icons.lock_open, size: 20),
          IconButton(tooltip: 'Переименовать', icon: const Icon(Icons.edit_outlined), onPressed: () => _rename(authority, label)),
        ]),
        onTap: () => _open(name, base),
      ),
    );
  }

  void _connectManual() {
    var text = _manual.text.trim();
    if (text.isEmpty) return;
    if (!text.contains('://')) text = 'http://$text';
    var uri = Uri.tryParse(text);
    if (uri == null || uri.host.isEmpty) return setState(() => _error = 'Неверный адрес');
    if (!uri.hasPort) uri = uri.replace(port: Prefs.instance.defaultPort);
    _open(uri.host, uri);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Подключение к ПК'), actions: [
          IconButton(tooltip: 'Искать заново', icon: const Icon(Icons.refresh), onPressed: _rescan),
          settingsButton(context),
        ]),
        body: ListenableBuilder(listenable: Prefs.instance, builder: (context, _) => ListView(padding: const EdgeInsets.all(16), children: [
          if (widget.onDisconnect != null) ...[
            Card(child: ListTile(
              leading: const Icon(Icons.link_off),
              title: const Text('Отключиться от ПК'),
              subtitle: const Text('Приложение продолжит работать само: очередь и серверы останутся на телефоне'),
              onTap: widget.onDisconnect,
            )),
            const SizedBox(height: 16),
          ],
          Text('Устройства в сети', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          const Text('Имя можно поменять карандашом — оно останется на этом телефоне', style: TextStyle(color: Colors.white54, fontSize: 12)),
          const SizedBox(height: 8),
          if (_found.isEmpty)
            const ListTile(leading: SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)), title: Text('Ищу…'),
                subtitle: Text('На ПК включите «Пульт для телефона» в настройках')),
          for (final pc in _found) _device(Icons.desktop_windows_outlined, pc.name, pc.base),
          if (Prefs.instance.pcs.any((pc) => !_found.any((f) => f.base.authority == pc.base.authority))) ...[
            const SizedBox(height: 16),
            Text('Запомненные', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            for (final pc in Prefs.instance.pcs.where((pc) => !_found.any((f) => f.base.authority == pc.base.authority)))
              _device(Icons.history, pc.name, pc.base),
          ],
          const SizedBox(height: 24),
          Text('Или адрес вручную', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(child: TextField(controller: _manual, keyboardType: TextInputType.url, onSubmitted: (_) => _connectManual(),
                decoration: InputDecoration(hintText: '192.168.1.5:${Prefs.instance.defaultPort}', border: const OutlineInputBorder()))),
            const SizedBox(width: 8),
            FilledButton(onPressed: _connectManual, child: const Text('Подключить')),
          ]),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: const TextStyle(color: Colors.redAccent))),
        ])),
      );
}

Widget settingsButton(BuildContext context, [Remote? remote]) => IconButton(
    tooltip: 'Настройки', icon: const Icon(Icons.settings_outlined),
    onPressed: () {
      FocusManager.instance.primaryFocus?.unfocus();
      Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => SettingsScreen(remote: remote)));
    });

/// Настройки приложения: запомненные компьютеры, автоподключение, превью, порт по умолчанию.
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, this.remote});
  final Remote? remote;
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final TextEditingController _port = TextEditingController(text: '${Prefs.instance.defaultPort}');

  @override
  void dispose() {
    _port.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: Prefs.instance,
        builder: (context, _) {
          final prefs = Prefs.instance;
          return Scaffold(
            appBar: AppBar(title: const Text('Настройки')),
            body: ListView(children: [
              ListTile(
                leading: const Icon(Icons.smartphone),
                title: const Text('Имя этого телефона'),
                subtitle: Text('${prefs.deviceName} — так он виден ПК в списке привязанных устройств'),
                trailing: const Icon(Icons.edit_outlined),
                onTap: () async {
                  final name = await renameDialog(context, prefs.deviceName, title: 'Имя этого телефона');
                  if (name != null) prefs.setDeviceName(name);
                },
              ),
              if (widget.remote != null && !widget.remote!.isLocal)
                ListTile(
                  leading: const Icon(Icons.podcasts),
                  title: const Text('Эфир на ПК'),
                  subtitle: const Text('Публичная ссылка, свой сервер, качество'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => StreamSettingsScreen(remote: widget.remote!))),
                ),
              SwitchListTile(title: const Text('Подключаться к последнему ПК сам'), subtitle: const Text('Иначе при запуске откроется выбор компьютера'),
                  value: prefs.autoConnect, onChanged: (v) => prefs.update(() => prefs.autoConnect = v)),
              SwitchListTile(title: const Text('Видео-превью'), subtitle: const Text('Выключите, чтобы не расходовать трафик Wi-Fi: останется картинка трека'),
                  value: prefs.preview, onChanged: (v) => prefs.update(() => prefs.preview = v)),
              ListTile(
                title: const Text('Порт по умолчанию'),
                subtitle: const Text('Подставляется, если адрес введён без порта. Должен совпадать с портом на ПК'),
                trailing: SizedBox(width: 90, child: TextField(controller: _port, keyboardType: TextInputType.number, textAlign: TextAlign.center,
                    decoration: const InputDecoration(isDense: true, border: OutlineInputBorder()),
                    onChanged: (text) {
                      final v = int.tryParse(text);
                      if (v != null && v >= 1024 && v <= 65400) prefs.update(() => prefs.defaultPort = v);
                    })),
              ),
              const Divider(),
              const Padding(padding: EdgeInsets.fromLTRB(16, 8, 16, 0), child: Text('Свои серверы', style: TextStyle(fontWeight: FontWeight.bold))),
              const Padding(padding: EdgeInsets.fromLTRB(16, 4, 16, 0), child: Text('Нужны, чтобы вещать экран телефона без ПК. Когда ПК на связи, серверы синхронизируются в обе стороны.', style: TextStyle(color: Colors.white54, fontSize: 12))),
              for (final server in prefs.ownServers)
                ListTile(
                  leading: Icon(server.id == prefs.currentOwnServer?.id ? Icons.radio_button_checked : Icons.radio_button_off),
                  title: Text(server.name),
                  subtitle: Text('${server.host}:${server.rtspPort}'),
                  onTap: () => prefs.selectOwnServer(server),
                  trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                    IconButton(tooltip: 'Изменить', icon: const Icon(Icons.edit_outlined), onPressed: () async {
                      final saved = await showDialog<OwnServer>(context: context, builder: (_) => _ServerDialog(server: server));
                      if (saved != null) { if (saved.id != server.id) prefs.removeOwnServer(server); prefs.saveOwnServer(saved); }
                    }),
                    IconButton(tooltip: 'Удалить', icon: const Icon(Icons.delete_outline), onPressed: () => prefs.removeOwnServer(server)),
                  ]),
                ),
              ListTile(
                leading: const Icon(Icons.add),
                title: const Text('Добавить сервер'),
                onTap: () async {
                  final saved = await showDialog<OwnServer>(context: context, builder: (_) => const _ServerDialog());
                  if (saved != null) prefs.saveOwnServer(saved);
                },
              ),
              if (widget.remote != null && widget.remote!.online && widget.remote!.api.token != null)
                ListTile(
                  leading: const Icon(Icons.sync),
                  title: const Text('Синхронизировать с ПК'),
                  subtitle: const Text('Серверы и ссылки, накопленные без связи, уйдут на ПК; серверы ПК появятся здесь'),
                  onTap: () async {
                    final added = await widget.remote!.syncServers();
                    await widget.remote!.pushPendingLinks();
                    if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(added > 0 ? 'С ПК получено серверов: $added' : 'Всё уже синхронизировано')));
                  },
                ),
              const Divider(),
              const Padding(padding: EdgeInsets.fromLTRB(16, 8, 16, 0), child: Text('Запомненные компьютеры', style: TextStyle(fontWeight: FontWeight.bold))),
              if (prefs.pcs.isEmpty) const ListTile(title: Text('Пока пусто', style: TextStyle(color: Colors.white54))),
              for (final pc in prefs.pcs)
                ListTile(leading: const Icon(Icons.desktop_windows_outlined), title: Text(prefs.nameFor(pc.base.authority, pc.name)), subtitle: Text(pc.base.authority),
                    trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                      IconButton(tooltip: 'Переименовать', icon: const Icon(Icons.edit_outlined), onPressed: () async {
                        final name = await renameDialog(context, prefs.nameFor(pc.base.authority, pc.name));
                        if (name != null) prefs.setAlias(pc.base.authority, name);
                      }),
                      IconButton(tooltip: 'Забыть', icon: const Icon(Icons.delete_outline), onPressed: () => prefs.forget(pc)),
                    ])),
              const Divider(),
              const ListTile(title: Text('Включить доступ на ПК'), subtitle: Text('Настройки → Программа → Пульт для телефона. Порт на ПК тоже меняется там')),
            ]),
          );
        },
      );
}

void toastError(BuildContext context, String? message) {
  if (message == null) return;
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message), backgroundColor: Colors.red.shade900));
}

/// Оболочка с тремя вкладками. Работает и с ПК, и без него: отдельного режима нет, данные хранятся
/// на телефоне и синхронизируются при подключении.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.remote, required this.onConnect, required this.onDisconnect});
  final Remote remote;
  final void Function(String name, Uri base) onConnect;
  final VoidCallback onDisconnect;
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _tab = 0;

  void _openConnect() {
    final remote = widget.remote;
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (routeContext) => ConnectScreen(
        onPick: (name, base) { Navigator.of(routeContext).pop(); widget.onConnect(name, base); },
        onDisconnect: remote.isLocal ? null : () { Navigator.of(routeContext).pop(); widget.onDisconnect(); },
      ),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final remote = widget.remote;
    return ListenableBuilder(
      listenable: remote,
      builder: (context, _) {
        final pages = [NowPlayingPage(remote: remote), QueuePage(remote: remote), LinksPage(remote: remote)];
        final offline = remote.isLocal || remote.link == Link.offline;
        return Scaffold(
          appBar: AppBar(
            title: Text(remote.isLocal ? 'VRCast Bridge' : Prefs.instance.nameFor(remote.api.base.authority, remote.pcName.isEmpty ? 'VRCast Bridge' : remote.pcName)),
            actions: [settingsButton(context, remote), IconButton(tooltip: remote.isLocal ? 'Подключиться к ПК' : 'Другой компьютер', icon: Icon(remote.isLocal ? Icons.computer : Icons.swap_horiz), onPressed: _openConnect)],
            bottom: remote.link == Link.online || remote.isLocal ? null : PreferredSize(
              preferredSize: const Size.fromHeight(3), child: LinearProgressIndicator(color: remote.link == Link.offline ? Colors.orange : accent)),
          ),
          body: Column(children: [
            if (remote.needsPin)
              Container(width: double.infinity, color: Colors.deepPurple.shade900, padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  child: Row(children: [
                    const Expanded(child: Text('Этот ПК защищён PIN-кодом.')),
                    TextButton(
                      onPressed: () async {
                        final token = await pinDialog(context, remote.api, title: Prefs.instance.nameFor(remote.api.base.authority, remote.pcName));
                        if (token != null) remote.acceptToken(token);
                      },
                      child: const Text('Ввести PIN'),
                    ),
                  ])),
            if (offline && !remote.needsPin)
              Container(width: double.infinity, color: remote.isLocal ? Colors.blueGrey.shade800 : Colors.orange.shade900, padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  child: Row(children: [
                    Expanded(child: Text(remote.isLocal
                        ? 'ПК не подключён. Показана последняя копия; что добавите, уйдёт на ПК при подключении.'
                        : 'Нет связи с ПК. Подключаюсь снова…')),
                    TextButton(onPressed: _openConnect, child: Text(remote.isLocal ? 'Подключиться' : 'Другой ПК')),
                  ])),
            Expanded(child: remote.state == null ? const Center(child: CircularProgressIndicator()) : pages[_tab]),
          ]),
          bottomNavigationBar: NavigationBar(selectedIndex: _tab, onDestinationSelected: (i) { FocusManager.instance.primaryFocus?.unfocus(); setState(() => _tab = i); }, destinations: const [
            NavigationDestination(icon: Icon(Icons.play_circle_outline), selectedIcon: Icon(Icons.play_circle), label: 'Сейчас'),
            NavigationDestination(icon: Icon(Icons.queue_music_outlined), selectedIcon: Icon(Icons.queue_music), label: 'Очередь'),
            NavigationDestination(icon: Icon(Icons.link), label: 'Ссылки'),
          ]),
        );
      },
    );
  }
}

/// Превью эфира: HLS через встроенный плеер, пока идёт поток; иначе миниатюра.
class Preview extends StatefulWidget {
  const Preview({super.key, required this.remote});
  final Remote remote;
  @override
  State<Preview> createState() => _PreviewState();
}

class _PreviewState extends State<Preview> {
  VideoPlayerController? _controller;
  bool _wanted = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(Preview old) {
    super.didUpdateWidget(old);
    _sync();
  }

  Timer? _retry;

  void _sync() {
    final state = widget.remote.state;
    final want = Prefs.instance.preview && state != null && state.running && state.streamReady;
    if (want == _wanted) return;
    _wanted = want;
    _retry?.cancel();
    _controller?.dispose();
    _controller = null;
    if (want) _open();
  }

  /// Открывает HLS-превью; плейлист в первые секунды эфира может быть ещё пуст — пробуем снова.
  void _open() {
    final controller = VideoPlayerController.networkUrl(Uri.parse(widget.remote.api.absolute('/stream/preview.m3u8')),
        videoPlayerOptions: VideoPlayerOptions(mixWithOthers: true))..setVolume(0);
    _controller = controller;
    void failed() {
      if (_controller != controller) return;
      controller.dispose();
      _controller = null;
      if (mounted) setState(() {});
      if (_wanted) _retry = Timer(const Duration(seconds: 2), () { if (mounted && _wanted && _controller == null) _open(); });
    }
    controller.initialize().then((_) {
      if (!mounted || _controller != controller) return;
      controller.play();
      controller.addListener(() { if (controller.value.hasError) failed(); });
      setState(() {});
    }).catchError((Object _) => failed());
  }

  @override
  void dispose() {
    _retry?.cancel();
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.remote.state!;
    final controller = _controller;
    final thumb = state.current?.thumbnail ?? '';
    Widget child;
    if (controller != null && controller.value.isInitialized) {
      child = VideoPlayer(controller);
    } else if (thumb.isNotEmpty) {
      child = Image.network(widget.remote.api.absolute(thumb), fit: BoxFit.cover, errorBuilder: (_, _, _) => const _NoPicture());
    } else {
      child = const _NoPicture();
    }
    return AspectRatio(aspectRatio: 16 / 9, child: ClipRRect(borderRadius: BorderRadius.circular(12), child: ColoredBox(color: Colors.black, child: child)));
  }
}

class _NoPicture extends StatelessWidget {
  const _NoPicture();
  @override
  Widget build(BuildContext context) => const Center(child: Icon(Icons.tv_off_outlined, size: 48, color: Colors.white24));
}

class NowPlayingPage extends StatefulWidget {
  const NowPlayingPage({super.key, required this.remote});
  final Remote remote;
  @override
  State<NowPlayingPage> createState() => _NowPlayingPageState();
}

class _NowPlayingPageState extends State<NowPlayingPage> {
  double? _drag; // пока палец на ползунке, показываем его позицию

  static const _speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  static const _loops = {'once': 'Без повтора', 'one': 'Повтор трека', 'all': 'Повтор списка'};

  Future<void> _do(Future<String?> action) async { final e = await action; if (mounted) toastError(context, e); }

  @override
  Widget build(BuildContext context) {
    final remote = widget.remote;
    final s = remote.state!;
    final position = _drag ?? s.positionAt(DateTime.now());
    final direct = remote.phone.live && !s.phoneSource; // экран телефона идёт прямо на свой сервер
    final title = s.phoneSource || direct ? 'Экран телефона' : s.isScreen ? 'Захват экрана' : (s.current?.title ?? (s.queue.isEmpty ? 'Очередь пуста' : 'Ничего не играет'));
    final seekable = s.canSeek && s.duration > 0;
    return ListView(padding: const EdgeInsets.all(16), children: [
      Preview(remote: remote),
      const SizedBox(height: 16),
      Text(title, style: Theme.of(context).textTheme.titleLarge, maxLines: 2, overflow: TextOverflow.ellipsis),
      const SizedBox(height: 4),
      Row(children: [
        Icon(Icons.circle, size: 10, color: direct ? Colors.greenAccent : s.running ? (s.paused || s.buffering ? Colors.amber : Colors.greenAccent) : Colors.grey),
        const SizedBox(width: 6),
        Text(direct ? 'Идёт экран телефона ${remote.streamTarget}' : s.statusLabel, style: const TextStyle(color: Colors.white70)),
      ]),
      const SizedBox(height: 8),
      Slider(
        value: seekable ? position.clamp(0, s.duration).toDouble() : 0,
        max: seekable ? s.duration : 1,
        onChanged: seekable ? (v) => setState(() => _drag = v) : null,
        onChangeEnd: seekable ? (v) {
          setState(() => _drag = null);
          _do(remote.playback('seek', {'position': v}));
        } : null,
      ),
      Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [Text(formatTime(position)), Text(seekable ? formatTime(s.duration) : '')])),
      const SizedBox(height: 8),
      Row(mainAxisAlignment: MainAxisAlignment.center, children: [
        IconButton(iconSize: 36, tooltip: 'Назад', icon: const Icon(Icons.skip_previous), onPressed: () => _do(remote.playback('previous'))),
        const SizedBox(width: 8),
        IconButton.filled(iconSize: 44, tooltip: s.paused ? 'Продолжить' : 'Пауза',
            icon: Icon(s.running && !s.paused ? Icons.pause : Icons.play_arrow),
            onPressed: () => _do(!s.running ? remote.run(() => remote.api.startQueue()) : remote.playback(s.paused ? 'resume' : 'pause', s.paused ? {} : {'position': position}))),
        const SizedBox(width: 8),
        IconButton(iconSize: 36, tooltip: 'Далее', icon: const Icon(Icons.skip_next), onPressed: () => _do(remote.playback('next'))),
      ]),
      const SizedBox(height: 8),
      Row(children: [
        const Icon(Icons.volume_up, color: Colors.white54),
        Expanded(child: Slider(value: s.mediaVolume.clamp(0, 1).toDouble(), onChanged: (v) => remote.playback('volume', {'volume': v}))),
      ]),
      Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.center, children: [
        PopupMenuButton<double>(
          onSelected: (v) => _do(remote.playback('speed', {'speed': v})),
          itemBuilder: (_) => [for (final v in _speeds) CheckedPopupMenuItem(value: v, checked: v == s.speed, child: Text('${v}x'))],
          child: Chip(avatar: const Icon(Icons.speed, size: 18), label: Text('${s.speed}x')),
        ),
        PopupMenuButton<String>(
          onSelected: (v) => _do(remote.playback('loop', {'mode': v})),
          itemBuilder: (_) => [for (final e in _loops.entries) CheckedPopupMenuItem(value: e.key, checked: e.key == s.loopMode, child: Text(e.value))],
          child: Chip(avatar: const Icon(Icons.repeat, size: 18), label: Text(_loops[s.loopMode] ?? s.loopMode)),
        ),
      ]),
      const SizedBox(height: 12),
      if (remote.online)
        _StreamSummary(state: s, onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => StreamSettingsScreen(remote: remote)))),
      if (!remote.online) _DirectSummary(remote: remote),
      const SizedBox(height: 12),
      remote.phone.live || s.phoneSource
          ? FilledButton.tonalIcon(onPressed: () => _do(remote.stopPhoneBroadcast()), icon: const Icon(Icons.stop_screen_share), label: const Text('Остановить трансляцию экрана'))
          : OutlinedButton.icon(onPressed: () => _do(remote.startPhoneBroadcast()), icon: const Icon(Icons.screen_share), label: Text(remote.streamTarget.isEmpty ? 'Транслировать экран телефона' : 'Транслировать экран телефона ${remote.streamTarget}')),
      const SizedBox(height: 8),
      s.running && !s.phoneSource
          ? OutlinedButton.icon(onPressed: () => _do(remote.run(remote.api.stop)), icon: const Icon(Icons.stop_circle_outlined), label: const Text('Остановить эфир'))
          : FilledButton.icon(onPressed: () => _do(remote.run(() => remote.api.startQueue())), icon: const Icon(Icons.podcasts), label: const Text('Начать эфир')),
    ]);
  }
}

class QueuePage extends StatefulWidget {
  const QueuePage({super.key, required this.remote});
  final Remote remote;
  @override
  State<QueuePage> createState() => _QueuePageState();
}

class _QueuePageState extends State<QueuePage> {
  final _link = TextEditingController();
  bool _adding = false;
  String? _uploadName; // файл, который сейчас уходит на ПК
  int _uploadIndex = 0, _uploadTotal = 0;
  double _uploadProgress = 0;

  static const _extensions = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'ts', 'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus'];

  /// Файлы с телефона уходят на ПК по одному и встают в очередь.
  Future<void> _pickAndUpload() async {
    if (_uploadName != null) return;
    if (!widget.remote.online) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Файлы отправляются на ПК: сначала подключитесь к ПК')));
      return;
    }
    final picked = await FilePicker.pickFiles(type: FileType.custom, allowedExtensions: _extensions);
    final files = picked.where((f) => f.path != null).toList();
    if (files.isEmpty) return;
    setState(() { _uploadTotal = files.length; _uploadIndex = 0; });
    var failed = 0;
    for (final file in files) {
      setState(() { _uploadName = file.name; _uploadProgress = 0; _uploadIndex += 1; });
      try {
        await widget.remote.api.uploadFile(file.path!, file.name, (p) { if (mounted && (p - _uploadProgress > 0.01 || p >= 1)) setState(() => _uploadProgress = p); });
      } catch (e) {
        failed += 1;
        if (mounted) toastError(context, '${file.name}: $e');
      }
    }
    if (!mounted) return;
    setState(() => _uploadName = null);
    if (failed == 0) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Отправлено на ПК: ${files.length}')));
  }

  @override
  void dispose() {
    _link.dispose();
    super.dispose();
  }

  Future<void> _add() async {
    final url = _link.text.trim();
    if (url.isEmpty || _adding) return;
    if (!widget.remote.online) {
      // Без связи ссылка ждёт у телефона и уйдёт в очередь ПК при подключении.
      Prefs.instance.addPendingLink(url);
      _link.clear();
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Ссылка сохранена: уйдёт на ПК при подключении')));
      return;
    }
    setState(() => _adding = true);
    try {
      var result = await widget.remote.api.addLink(url);
      if (result['ask'] != null && mounted) {
        final ok = await showDialog<bool>(context: context, builder: (c) => AlertDialog(
          title: const Text('Большой плейлист'), content: Text('${(result['ask'] as Map?)?['message'] ?? 'Добавить все ролики?'}'),
          actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Отмена')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Добавить'))]));
        if (ok == true) { result = await widget.remote.api.addLink(url, confirm: true); } else { result = {}; }
      }
      _link.clear();
    } catch (e) {
      if (mounted) toastError(context, '$e');
    } finally {
      if (mounted) setState(() => _adding = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final remote = widget.remote;
    final s = remote.state!;
    return Column(children: [
      Padding(padding: const EdgeInsets.all(12), child: Row(children: [
        Expanded(child: TextField(controller: _link, keyboardType: TextInputType.url, onSubmitted: (_) => _add(),
            decoration: const InputDecoration(hintText: 'Ссылка на видео или плейлист', border: OutlineInputBorder(), isDense: true))),
        const SizedBox(width: 8),
        FilledButton(onPressed: _adding ? null : _add, child: _adding ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Добавить')),
      ])),
      if (_uploadName != null)
        Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 8), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Отправляю на ПК ($_uploadIndex из $_uploadTotal): $_uploadName', maxLines: 1, overflow: TextOverflow.ellipsis),
          const SizedBox(height: 4),
          LinearProgressIndicator(value: _uploadProgress),
        ])),
      Padding(padding: const EdgeInsets.fromLTRB(12, 0, 12, 4), child: Align(alignment: Alignment.centerLeft, child: TextButton.icon(
          onPressed: _uploadName == null ? _pickAndUpload : null, icon: const Icon(Icons.upload_file), label: const Text('Добавить файлы с телефона')))),
      ListenableBuilder(
        listenable: Prefs.instance,
        builder: (context, _) => Column(children: [
          for (final pending in Prefs.instance.pendingLinks)
            ListTile(
              dense: true,
              leading: const Icon(Icons.schedule_send_outlined),
              title: Text(pending, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: const Text('Ждёт подключения к ПК'),
              trailing: IconButton(tooltip: 'Убрать', icon: const Icon(Icons.close), onPressed: () => Prefs.instance.removePendingLink(pending)),
            ),
        ]),
      ),
      Expanded(child: s.queue.isEmpty
          ? const Center(child: Text('Очередь пуста', style: TextStyle(color: Colors.white54)))
          : ReorderableListView.builder(
              itemCount: s.queue.length,
              onReorderItem: (from, to) {
                remote.run(() => remote.api.moveInQueue(s.queue[from].id, to)).then((e) { if (mounted) toastError(context, e); });
              },
              itemBuilder: (context, i) {
                final item = s.queue[i];
                final playing = item.id == s.currentId && s.running;
                return Dismissible(
                  key: ValueKey(item.id),
                  direction: DismissDirection.endToStart,
                  background: Container(color: Colors.red.shade900, alignment: Alignment.centerRight, padding: const EdgeInsets.only(right: 20), child: const Icon(Icons.delete)),
                  onDismissed: (_) => remote.run(() => remote.api.removeFromQueue(item.id)),
                  child: ListTile(
                    key: ValueKey('t${item.id}'),
                    leading: SizedBox(width: 72, height: 40, child: ClipRRect(borderRadius: BorderRadius.circular(6), child: item.thumbnail.isEmpty
                        ? const ColoredBox(color: Colors.black26)
                        : Image.network(remote.api.absolute(item.thumbnail), fit: BoxFit.cover, errorBuilder: (_, _, _) => const ColoredBox(color: Colors.black26)))),
                    title: Text(item.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: item.unavailable ? Colors.redAccent : null, fontWeight: playing ? FontWeight.bold : null)),
                    subtitle: Text(item.duration > 0 ? formatTime(item.duration) : ''),
                    trailing: playing ? const Icon(Icons.equalizer, color: accent) : null,
                    onTap: () async { final e = await remote.playback('jump', {'id': item.id}); if (context.mounted) toastError(context, e); },
                  ),
                );
              })),
    ]);
  }
}

class LinksPage extends StatelessWidget {
  const LinksPage({super.key, required this.remote});
  final Remote remote;

  @override
  Widget build(BuildContext context) {
    final s = remote.state!;
    final host = remote.api.base.host;
    final server = Prefs.instance.currentOwnServer;
    if (!remote.online) {
      // Без ПК остаётся ссылка на свой сервер: она не меняется, пока сервер на месте.
      if (server == null) return const Center(child: Padding(padding: EdgeInsets.all(24), child: Text('Ссылки появятся, когда подключитесь к ПК или добавите свой сервер в настройках', textAlign: TextAlign.center, style: TextStyle(color: Colors.white54))));
      return ListView(padding: const EdgeInsets.all(12), children: [_LinkCard(title: 'Ссылка для плеера (свой сервер)', hint: 'Экран телефона на «${server.name}». Не меняется, пока сервер на месте', url: server.viewLink)]);
    }
    // Сервер называет себя 127.0.0.1 — для телефона подставляем адрес ПК.
    final stream = s.playbackUrl.replaceFirst('127.0.0.1', host);
    final rows = <(String, String, String)>[
      if (stream.isNotEmpty) ('Ссылка для плеера', stream, 'Основная ссылка эфира: работает на ПК и в вашей сети'),
      for (final url in s.rtspLanUrls) ('Быстрая ссылка (rtspt)', url, 'Для AVPro: нужна, если плеер в одной сети с ПК'),
      if (s.tunnelUrl.isNotEmpty) ('Публичная ссылка', s.tunnelUrl, 'Для друзей через интернет'),
    ];
    if (rows.isEmpty) return const Center(child: Text('Ссылок пока нет', style: TextStyle(color: Colors.white54)));
    return ListView(padding: const EdgeInsets.all(12), children: [
      for (final (title, url, hint) in rows)
        Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 2),
          Text(hint, style: const TextStyle(color: Colors.white54, fontSize: 12)),
          const SizedBox(height: 8),
          SelectableText(url, style: const TextStyle(fontFamily: 'monospace', fontSize: 13)),
          Row(mainAxisAlignment: MainAxisAlignment.end, children: [
            TextButton.icon(onPressed: () { Clipboard.setData(ClipboardData(text: url)); ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Скопировано'))); },
                icon: const Icon(Icons.copy, size: 18), label: const Text('Копировать')),
            TextButton.icon(onPressed: () => SharePlus.instance.share(ShareParams(text: url)), icon: const Icon(Icons.share, size: 18), label: const Text('Поделиться')),
          ]),
        ]))),
    ]);
  }
}

/// Настройки эфира на ПК с телефона: куда идёт поток, публичная ссылка, свой сервер, качество.
/// Нужна привязка по коду из настроек программы на ПК.
class StreamSettingsScreen extends StatefulWidget {
  const StreamSettingsScreen({super.key, required this.remote});
  final Remote remote;
  @override
  State<StreamSettingsScreen> createState() => _StreamSettingsScreenState();
}

class _StreamSettingsScreenState extends State<StreamSettingsScreen> {
  bool? _paired;
  bool _busy = false;
  final _code = TextEditingController();
  late final TextEditingController _ip = TextEditingController(text: widget.remote.state?.whiteIp ?? '');
  final _ipFocus = FocusNode();

  static const _tunnelStates = {'idle': 'ожидание', 'starting': 'запускается', 'ready': 'готова', 'error': 'ошибка', 'verifying': 'проверяется'};
  static const _providers = {'auto': 'Авто — самый быстрый', 'cloudflare': 'Cloudflare', 'localhostrun': 'localhost.run', 'serveo': 'Serveo'};

  @override
  void initState() {
    super.initState();
    widget.remote.api.pairCheck().then((value) { if (mounted) setState(() => _paired = value); });
  }

  @override
  void dispose() {
    _code.dispose();
    _ip.dispose();
    _ipFocus.dispose();
    super.dispose();
  }

  Future<void> _pair() async {
    final api = widget.remote.api;
    setState(() => _busy = true);
    try {
      final token = await api.pair(_code.text, 'Телефон');
      api.token = token;
      Prefs.instance.setToken(api.base.toString(), token);
      final copied = await widget.remote.syncServers();
      if (mounted) {
        setState(() => _paired = true);
        if (copied > 0) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Серверы с ПК скопированы на телефон: $copied')));
      }
    } catch (e) {
      if (mounted) toastError(context, '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _set(Map<String, Object?> values) async {
    // Качество, кадры и кодировщик в идущем эфире применяем сразу, как кнопки на ПК.
    final live = (widget.remote.state?.running ?? false) && values.keys.any(const {'quality', 'fps', 'encoderMode'}.contains);
    final error = await widget.remote.run(() => widget.remote.api.setStream({...values, if (live) 'applyLive': true}));
    if (mounted) toastError(context, error);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Эфир на ПК')),
        body: _paired == null
            ? const Center(child: CircularProgressIndicator())
            : ListenableBuilder(listenable: widget.remote, builder: (context, _) => _settings(widget.remote.state)),
      );

  Widget _pairingBanner() => Card(margin: const EdgeInsets.all(16), child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [const Icon(Icons.phonelink_lock), const SizedBox(width: 8), Expanded(child: Text('Настройки с ПК видны, менять их нельзя', style: Theme.of(context).textTheme.titleMedium))]),
        const SizedBox(height: 8),
        const Text('Чтобы менять эфир с телефона, введите код с ПК: Настройки → Программа → «Код привязки телефона». Один раз.'),
        const SizedBox(height: 12),
        TextField(controller: _code, keyboardType: TextInputType.number, maxLength: 7, onSubmitted: (_) => _pair(),
            decoration: const InputDecoration(labelText: 'Код с ПК', hintText: '123 456', border: OutlineInputBorder())),
        const SizedBox(height: 8),
        FilledButton(onPressed: _busy ? null : _pair, child: _busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Привязать')),
      ])));

  Widget _settings(BridgeState? s) {
    if (s == null) return const Center(child: CircularProgressIndicator());
    final editable = _paired == true;
    // Пока поле не в фокусе, показываем то, что стоит на ПК.
    if (!_ipFocus.hasFocus && _ip.text != s.whiteIp) _ip.text = s.whiteIp;
    Widget title(String text) => Padding(padding: const EdgeInsets.fromLTRB(16, 20, 16, 8), child: Text(text, style: const TextStyle(fontWeight: FontWeight.bold)));
    return ListView(children: [
      if (!editable) _pairingBanner(),
      title('Куда идёт эфир'),
      Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: SegmentedButton<String>(
        segments: const [
          ButtonSegment(value: 'local', label: Text('Локально'), icon: Icon(Icons.home_outlined)),
          ButtonSegment(value: 'tunnel', label: Text('Ссылка'), icon: Icon(Icons.public)),
          ButtonSegment(value: 'remote', label: Text('Сервер'), icon: Icon(Icons.dns_outlined)),
        ],
        selected: {s.outputMode},
        onSelectionChanged: editable ? (v) => _set({'outputMode': v.first}) : null,
      )),
      if (s.outputMode == 'tunnel') ...[
        title('Публичная ссылка'),
        ListTile(
          title: const Text('Сервис быстрой ссылки'),
          trailing: DropdownButton<String>(
            value: _providers.containsKey(s.tunnelProvider) ? s.tunnelProvider : 'auto',
            items: [for (final e in _providers.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
            onChanged: editable ? (v) => v == null ? null : _set({'tunnelProvider': v}) : null,
          ),
        ),
        ListTile(
          title: Text(s.tunnelUrl.isEmpty ? 'Ссылка появится, когда начнётся эфир' : s.tunnelUrl),
          subtitle: Text('Состояние: ${_tunnelStates[s.tunnelState] ?? (s.tunnelState.isEmpty ? 'ожидание' : s.tunnelState)}'),
          trailing: s.tunnelUrl.isEmpty ? null : IconButton(icon: const Icon(Icons.copy), onPressed: () => Clipboard.setData(ClipboardData(text: s.tunnelUrl))),
        ),
      ],
      if (s.outputMode == 'remote') ...[
        title('Свой сервер'),
        if (s.servers.isEmpty)
          const ListTile(title: Text('Серверов пока нет'), subtitle: Text('Добавить сервер можно в программе на ПК: Настройки → Сеть и серверы'))
        else
          for (final server in s.servers)
            RadioListTile<String>(
              value: server.id,
              groupValue: s.activeServerId,
              title: Text(server.name),
              subtitle: Text(server.reachable == null ? 'Проверка…' : server.reachable! ? 'Отвечает' : 'Не отвечает'),
              onChanged: editable ? (v) => v == null ? null : _set({'activeServerId': v}) : null,
            ),
      ],
      title('Прямой адрес (белый IP или домен ПК)'),
      Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: TextField(
        controller: _ip,
        focusNode: _ipFocus,
        enabled: editable,
        decoration: const InputDecoration(hintText: '203.0.113.7', border: OutlineInputBorder(), isDense: true),
        onSubmitted: (v) => _set({'whiteIp': v.trim()}),
      )),
      title('Качество'),
      Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Wrap(spacing: 8, runSpacing: 8, children: [
        for (final q in const ['480p', '720p', '1080p']) ChoiceChip(label: Text(q), selected: s.quality == q, onSelected: editable ? (_) => _set({'quality': q}) : null),
        for (final f in const [30, 60]) ChoiceChip(label: Text('$f к/с'), selected: s.fps == f, onSelected: editable ? (_) => _set({'fps': f}) : null),
      ])),
      title('Кодировщик'),
      Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: SegmentedButton<String>(
        segments: const [
          ButtonSegment(value: 'auto', label: Text('Авто')),
          ButtonSegment(value: 'gpu', label: Text('Видеокарта')),
          ButtonSegment(value: 'cpu', label: Text('Процессор')),
        ],
        selected: {s.encoderMode},
        onSelectionChanged: editable ? (v) => _set({'encoderMode': v.first}) : null,
      )),
      const SizedBox(height: 24),
      const Padding(padding: EdgeInsets.symmetric(horizontal: 16), child: Text('Порт, папка кеша, доступ из сети и добавление серверов меняются только на самом ПК.', style: TextStyle(color: Colors.white54))),
      const SizedBox(height: 24),
    ]);
  }
}

/// Сводка эфира на ПК: куда идёт, в каком качестве и как себя чувствует. Всё берётся с ПК.
class _StreamSummary extends StatelessWidget {
  const _StreamSummary({required this.state, required this.onTap});
  final BridgeState state;
  final VoidCallback onTap;

  static const _modes = {'local': 'Локально', 'tunnel': 'Публичная ссылка', 'remote': 'Свой сервер'};

  @override
  Widget build(BuildContext context) {
    final s = state;
    final problem = s.deliveryError.isNotEmpty;
    final status = problem ? s.deliveryError : s.deliveryReady ? 'Ссылка готова' : s.running ? 'Готовится…' : 'Эфир не идёт';
    final color = problem ? Colors.redAccent : s.deliveryReady ? Colors.greenAccent : Colors.amber;
    final details = [
      _modes[s.outputMode] ?? s.outputMode,
      '${s.profileQuality} · ${s.profileFps} к/с',
      if (s.profileBitrateKbps > 0) '${(s.profileBitrateKbps / 1000).toStringAsFixed(1)} Мбит/с',
      if (s.encoderLabel.isNotEmpty) s.encoderLabel,
    ].join('  ·  ');
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(children: [
            Icon(Icons.podcasts, color: color),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(status, style: TextStyle(color: color, fontWeight: FontWeight.w600)),
              const SizedBox(height: 2),
              Text(details, style: const TextStyle(color: Colors.white70, fontSize: 13)),
              if (s.pendingProfile.isNotEmpty) Text('Со следующего запуска: ${s.pendingProfile}', style: const TextStyle(color: Colors.amber, fontSize: 12)),
            ])),
            const Icon(Icons.chevron_right, color: Colors.white38),
          ]),
        ),
      ),
    );
  }
}

/// Без ПК: куда пойдёт экран телефона и по какой ссылке его смотреть.
class _DirectSummary extends StatelessWidget {
  const _DirectSummary({required this.remote});
  final Remote remote;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: Prefs.instance,
        builder: (context, _) {
          final server = Prefs.instance.currentOwnServer;
          final prefs = Prefs.instance;
          return Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(children: [
                Icon(Icons.cloud_upload_outlined, color: server == null ? Colors.amber : Colors.greenAccent),
                const SizedBox(width: 12),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(server == null ? 'Нет ПК и нет своего сервера' : 'Свой сервер: ${server.name}', style: const TextStyle(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  Text(server == null ? 'Подключитесь к ПК или добавьте сервер в настройках' : '${prefs.standaloneQuality} · ${prefs.standaloneFps} к/с · ${server.viewLink}',
                      style: const TextStyle(color: Colors.white70, fontSize: 13)),
                  if (remote.phone.live && remote.phone.lacksH264)
                    const Text('У телефона нет H.264: VRChat такой поток не воспроизведёт. Вещайте через ПК.', style: TextStyle(color: Colors.amber, fontSize: 12)),
                ])),
              ]),
            ),
          );
        },
      );
}

class _LinkCard extends StatelessWidget {
  const _LinkCard({required this.title, required this.hint, required this.url});
  final String title;
  final String hint;
  final String url;

  @override
  Widget build(BuildContext context) => Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 2),
        Text(hint, style: const TextStyle(color: Colors.white54, fontSize: 12)),
        const SizedBox(height: 8),
        SelectableText(url, style: const TextStyle(fontFamily: 'monospace', fontSize: 13)),
        Row(mainAxisAlignment: MainAxisAlignment.end, children: [
          TextButton.icon(onPressed: () { Clipboard.setData(ClipboardData(text: url)); ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Скопировано'))); },
              icon: const Icon(Icons.copy, size: 18), label: const Text('Копировать')),
          TextButton.icon(onPressed: () => SharePlus.instance.share(ShareParams(text: url)), icon: const Icon(Icons.share, size: 18), label: const Text('Поделиться')),
        ]),
      ])));
}

class _ServerDialog extends StatefulWidget {
  const _ServerDialog({this.server});
  final OwnServer? server;
  @override
  State<_ServerDialog> createState() => _ServerDialogState();
}

class _ServerDialogState extends State<_ServerDialog> {
  late final _name = TextEditingController(text: widget.server?.name ?? '');
  late final _host = TextEditingController(text: widget.server?.host ?? '');
  late final _port = TextEditingController(text: '${widget.server?.rtspPort ?? 8554}');
  late final _key = TextEditingController(text: widget.server?.key ?? '');
  String? _error;

  @override
  void dispose() {
    for (final c in [_name, _host, _port, _key]) { c.dispose(); }
    super.dispose();
  }

  void _save() {
    final error = OwnServer.validate(host: _host.text, port: _port.text, key: _key.text);
    if (error != null) return setState(() => _error = error);
    Navigator.pop(context, OwnServer(
      name: _name.text.trim().isEmpty ? _host.text.trim() : _name.text.trim(),
      host: _host.text.trim(), rtspPort: int.parse(_port.text.trim()), key: _key.text.trim()));
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: Text(widget.server == null ? 'Новый сервер' : 'Сервер'),
        content: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: _name, decoration: const InputDecoration(labelText: 'Название (необязательно)')),
          TextField(controller: _host, keyboardType: TextInputType.url, decoration: const InputDecoration(labelText: 'Адрес сервера', hintText: '203.0.113.7')),
          TextField(controller: _port, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Порт RTSP')),
          TextField(controller: _key, decoration: const InputDecoration(labelText: 'Ключ')),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error!, style: const TextStyle(color: Colors.redAccent))),
        ])),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Отмена')),
          FilledButton(onPressed: _save, child: const Text('Сохранить')),
        ],
      );
}
