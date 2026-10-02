import 'dart:async';

import 'package:flutter/material.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';
import 'package:video_player/video_player.dart';

import 'discovery.dart';
import 'models.dart';
import 'remote.dart';

const accent = Color(0xFF8B6BFF);

/// Подключение: найденные в сети ПК и ручной ввод адреса.
class ConnectScreen extends StatefulWidget {
  const ConnectScreen({super.key, required this.onPick});
  final void Function(String name, Uri base) onPick;
  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen> {
  List<FoundPc> _found = const [];
  late final Discovery _discovery = Discovery((list) => mounted ? setState(() => _found = list) : null);
  final _manual = TextEditingController();
  String? _error;

  @override
  void initState() {
    super.initState();
    _discovery.start().catchError((Object e) => mounted ? setState(() => _error = 'Поиск в сети недоступен: $e') : null);
  }

  @override
  void dispose() {
    _discovery.stop();
    _manual.dispose();
    super.dispose();
  }

  void _connectManual() {
    var text = _manual.text.trim();
    if (text.isEmpty) return;
    if (!text.contains('://')) text = 'http://$text';
    var uri = Uri.tryParse(text);
    if (uri == null || uri.host.isEmpty) return setState(() => _error = 'Неверный адрес');
    if (!uri.hasPort) uri = uri.replace(port: Prefs.instance.defaultPort);
    widget.onPick(uri.host, uri);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('VRCast Bridge'), actions: [settingsButton(context)]),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          if (Prefs.instance.pcs.isNotEmpty) ...[
            Text('Запомненные', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            for (final pc in Prefs.instance.pcs)
              Card(child: ListTile(leading: const Icon(Icons.history), title: Text(pc.name), subtitle: Text(pc.base.authority),
                  trailing: const Icon(Icons.chevron_right), onTap: () => widget.onPick(pc.name, pc.base))),
            const SizedBox(height: 16),
          ],
          Text('Компьютеры в сети', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          if (_found.isEmpty)
            const ListTile(leading: SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)), title: Text('Ищу…'),
                subtitle: Text('На ПК включите «Пульт для телефона» в настройках')),
          for (final pc in _found)
            Card(child: ListTile(leading: const Icon(Icons.desktop_windows_outlined), title: Text(pc.name), subtitle: Text('${pc.host}:${pc.port}'),
                trailing: const Icon(Icons.chevron_right), onTap: () => widget.onPick(pc.name, pc.base))),
          const SizedBox(height: 24),
          Text('Или адрес вручную', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(child: TextField(controller: _manual, keyboardType: TextInputType.url, onSubmitted: (_) => _connectManual(),
                decoration: InputDecoration(hintText: '192.168.1.5:${Prefs.instance.defaultPort}', border: OutlineInputBorder()))),
            const SizedBox(width: 8),
            FilledButton(onPressed: _connectManual, child: const Text('Подключить')),
          ]),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: const TextStyle(color: Colors.redAccent))),
        ]),
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
              if (widget.remote != null)
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
              const Padding(padding: EdgeInsets.fromLTRB(16, 8, 16, 0), child: Text('Запомненные компьютеры', style: TextStyle(fontWeight: FontWeight.bold))),
              if (prefs.pcs.isEmpty) const ListTile(title: Text('Пока пусто', style: TextStyle(color: Colors.white54))),
              for (final pc in prefs.pcs)
                ListTile(leading: const Icon(Icons.desktop_windows_outlined), title: Text(pc.name), subtitle: Text(pc.base.authority),
                    trailing: IconButton(tooltip: 'Забыть', icon: const Icon(Icons.delete_outline), onPressed: () => prefs.forget(pc))),
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

/// Оболочка с тремя вкладками и строкой состояния связи.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.remote, required this.onDisconnect});
  final Remote remote;
  final VoidCallback onDisconnect;
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final remote = widget.remote;
    return ListenableBuilder(
      listenable: remote,
      builder: (context, _) {
        final pages = [NowPlayingPage(remote: remote), QueuePage(remote: remote), LinksPage(remote: remote)];
        return Scaffold(
          appBar: AppBar(
            title: Text(remote.pcName.isEmpty ? 'VRCast Bridge' : remote.pcName),
            actions: [settingsButton(context, remote), IconButton(tooltip: 'Другой компьютер', icon: const Icon(Icons.swap_horiz), onPressed: widget.onDisconnect)],
            bottom: remote.link == Link.online ? null : PreferredSize(
              preferredSize: const Size.fromHeight(3), child: LinearProgressIndicator(color: remote.link == Link.offline ? Colors.orange : accent)),
          ),
          body: Column(children: [
            if (remote.link == Link.offline)
              Container(width: double.infinity, color: Colors.orange.shade900, padding: const EdgeInsets.all(8),
                  child: const Text('Нет связи с ПК. Подключаюсь снова…', textAlign: TextAlign.center)),
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
    final title = s.phoneSource ? 'Экран телефона' : s.isScreen ? 'Захват экрана' : (s.current?.title ?? (s.queue.isEmpty ? 'Очередь пуста' : 'Ничего не играет'));
    final seekable = s.canSeek && s.duration > 0;
    return ListView(padding: const EdgeInsets.all(16), children: [
      Preview(remote: remote),
      const SizedBox(height: 16),
      Text(title, style: Theme.of(context).textTheme.titleLarge, maxLines: 2, overflow: TextOverflow.ellipsis),
      const SizedBox(height: 4),
      Row(children: [
        Icon(Icons.circle, size: 10, color: s.running ? (s.paused || s.buffering ? Colors.amber : Colors.greenAccent) : Colors.grey),
        const SizedBox(width: 6),
        Text(s.statusLabel, style: const TextStyle(color: Colors.white70)),
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
      const SizedBox(height: 16),
      remote.phone.live || s.phoneSource
          ? FilledButton.tonalIcon(onPressed: () => _do(remote.stopPhoneBroadcast()), icon: const Icon(Icons.stop_screen_share), label: const Text('Остановить трансляцию экрана'))
          : OutlinedButton.icon(onPressed: () => _do(remote.startPhoneBroadcast()), icon: const Icon(Icons.screen_share), label: const Text('Транслировать экран телефона')),
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
    super.dispose();
  }

  Future<void> _pair() async {
    final api = widget.remote.api;
    setState(() => _busy = true);
    try {
      final token = await api.pair(_code.text, 'Телефон');
      api.token = token;
      Prefs.instance.setToken(api.base.toString(), token);
      if (mounted) setState(() => _paired = true);
    } catch (e) {
      if (mounted) toastError(context, '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _set(Map<String, Object?> values) async {
    final error = await widget.remote.run(() => widget.remote.api.setStream(values));
    if (mounted) toastError(context, error);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Эфир на ПК')),
        body: _paired == null
            ? const Center(child: CircularProgressIndicator())
            : _paired == false
                ? _pairing()
                : ListenableBuilder(listenable: widget.remote, builder: (context, _) => _settings(widget.remote.state)),
      );

  Widget _pairing() => ListView(padding: const EdgeInsets.all(16), children: [
        const Icon(Icons.phonelink_lock, size: 48),
        const SizedBox(height: 12),
        Text('Привяжите телефон к ПК', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 8),
        const Text('Настройки эфира открывают доступ к серверам, поэтому нужен код. На ПК: Настройки → Программа → «Код привязки телефона». Вводить нужно один раз.'),
        const SizedBox(height: 16),
        TextField(controller: _code, keyboardType: TextInputType.number, maxLength: 7, onSubmitted: (_) => _pair(),
            decoration: const InputDecoration(labelText: 'Код с ПК', hintText: '123 456', border: OutlineInputBorder())),
        const SizedBox(height: 8),
        FilledButton(onPressed: _busy ? null : _pair, child: _busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Привязать')),
      ]);

  Widget _settings(BridgeState? s) {
    if (s == null) return const Center(child: CircularProgressIndicator());
    Widget title(String text) => Padding(padding: const EdgeInsets.fromLTRB(16, 20, 16, 8), child: Text(text, style: const TextStyle(fontWeight: FontWeight.bold)));
    return ListView(children: [
      title('Куда идёт эфир'),
      Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: SegmentedButton<String>(
        segments: const [
          ButtonSegment(value: 'local', label: Text('Локально'), icon: Icon(Icons.home_outlined)),
          ButtonSegment(value: 'tunnel', label: Text('Ссылка'), icon: Icon(Icons.public)),
          ButtonSegment(value: 'remote', label: Text('Сервер'), icon: Icon(Icons.dns_outlined)),
        ],
        selected: {s.outputMode},
        onSelectionChanged: (v) => _set({'outputMode': v.first}),
      )),
      if (s.outputMode == 'tunnel') ...[
        title('Публичная ссылка'),
        ListTile(
          title: const Text('Сервис быстрой ссылки'),
          trailing: DropdownButton<String>(
            value: _providers.containsKey(s.tunnelProvider) ? s.tunnelProvider : 'auto',
            items: [for (final e in _providers.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
            onChanged: (v) => v == null ? null : _set({'tunnelProvider': v}),
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
              onChanged: (v) => v == null ? null : _set({'activeServerId': v}),
            ),
      ],
      title('Прямой адрес (белый IP или домен ПК)'),
      Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: TextField(
        controller: _ip,
        decoration: const InputDecoration(hintText: '203.0.113.7', border: OutlineInputBorder(), isDense: true),
        onSubmitted: (v) => _set({'whiteIp': v.trim()}),
      )),
      title('Качество'),
      Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Wrap(spacing: 8, runSpacing: 8, children: [
        for (final q in const ['480p', '720p', '1080p']) ChoiceChip(label: Text(q), selected: s.quality == q, onSelected: (_) => _set({'quality': q})),
        for (final f in const [30, 60]) ChoiceChip(label: Text('$f к/с'), selected: s.fps == f, onSelected: (_) => _set({'fps': f})),
      ])),
      title('Кодировщик'),
      Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: SegmentedButton<String>(
        segments: const [
          ButtonSegment(value: 'auto', label: Text('Авто')),
          ButtonSegment(value: 'gpu', label: Text('Видеокарта')),
          ButtonSegment(value: 'cpu', label: Text('Процессор')),
        ],
        selected: {s.encoderMode},
        onSelectionChanged: (v) => _set({'encoderMode': v.first}),
      )),
      const SizedBox(height: 24),
      const Padding(padding: EdgeInsets.symmetric(horizontal: 16), child: Text('Порт, папка кеша, доступ из сети и добавление серверов меняются только на самом ПК.', style: TextStyle(color: Colors.white54))),
      const SizedBox(height: 24),
    ]);
  }
}
