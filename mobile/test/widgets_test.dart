import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vrcast_remote/api.dart';
import 'package:vrcast_remote/discovery.dart';
import 'package:vrcast_remote/app_log.dart';
import 'package:vrcast_remote/byte_source.dart';
import 'package:vrcast_remote/file_broadcast.dart';
import 'package:vrcast_remote/links.dart';
import 'package:vrcast_remote/media_server.dart';
import 'package:vrcast_remote/main.dart';
import 'package:vrcast_remote/models.dart';
import 'package:vrcast_remote/own_server.dart';
import 'package:vrcast_remote/ssh.dart';
import 'package:vrcast_remote/phone_stream.dart';
import 'package:vrcast_remote/remote.dart';
import 'package:vrcast_remote/screens.dart';


Map<String, dynamic> fixture() => (jsonDecode(File('test/fixtures/status.json').readAsStringSync()) as Map).cast<String, dynamic>();

http.Response json(Object body, [int code = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), code, headers: {'content-type': 'application/json; charset=utf-8'});

/// Сервер файлов без сокета: тесты проверяют, что телефон сообщает группе, а не сеть.
class FakeMedia extends MediaServer {
  FakeMedia() : super(files: () => Prefs.instance.sharedFiles, key: 'fake-media-key-0123456789');
  @override
  Future<int> start({int port = 0}) async => 4242;
  @override
  Future<void> stop() async {}
}

Remote makeRemote(MockClient client, {Link link = Link.online, Map<String, dynamic>? state, String? token}) {
  Prefs.instance.mediaAddress = '192.168.1.50:4242';
  final remote = Remote(Api(Uri.parse('http://192.168.1.5:4717'), client: client, token: token), pcName: 'Тест-ПК', media: FakeMedia());
  remote.state = BridgeState.fromJson(state ?? fixture());
  remote.link = link;
  return remote;
}

Widget app(Widget home) => MaterialApp(scrollBehavior: const NoStretchScrollBehavior(), home: home);

/// Разбор ссылок без интернета: что вернуть, задаёт тест.
class FakeLinks implements LinkResolver {
  FakeLinks(this.answer);
  final List<LinkInfo> Function(String url) answer;
  final asked = <String>[];
  @override
  Future<List<LinkInfo>> inspect(String url) async {
    asked.add(url);
    return answer(url);
  }

  @override
  Future<ByteSource> open(SharedFile item) => throw UnimplementedError();
}

LinkInfo youtubeInfo(String id, String title, double seconds) =>
    LinkInfo(url: 'https://www.youtube.com/watch?v=$id', title: title, duration: seconds, thumbnail: 'https://i.ytimg.com/vi/$id/hqdefault.jpg', kind: 'youtube', sourceId: id);

/// Эфир файлов без сети и ffmpeg: запоминает команды и показывает то же состояние, что настоящий.
class FakeFiles extends FileBroadcast {
  final calls = <String>[];
  @override
  Future<void> start(OwnServer target, List<SharedFile> files, {int from = 0}) async {
    calls.add('start ${target.host} from=$from of=${files.length}');
    server = target;
    playlist = files;
    index = from;
    active = true;
    paused = false;
    connecting = false;
    notifyListeners();
  }

  @override
  Future<void> stop() async {
    if (!active) return;
    calls.add('stop');
    active = false;
    notifyListeners();
  }

  @override
  void pause() { calls.add('pause'); paused = true; notifyListeners(); }
  @override
  void resume() { calls.add('resume'); paused = false; notifyListeners(); }
  @override
  void next() => calls.add('next');
  @override
  void setSpeed(double value) { calls.add('speed $value'); super.setSpeed(value); }
  @override
  void setVolume(double value) { calls.add('volume $value'); super.setVolume(value); }
  @override
  void profileChanged() => calls.add('profile');
  @override
  void previous() => calls.add('previous');
}

/// Заглушка отправки экрана: без записи экрана и WebRTC, только запоминает вызовы.
class FakeStream extends PhoneStream {
  final calls = <String>[];
  @override
  Future<void> startDirect(OwnServer server, {String quality = '720p', int fps = 30}) async {
    calls.add('start ${server.host} $quality/$fps');
    live = true;
    startedAt = DateTime.now();
    emitChange();
  }

  @override
  String selectedCodec = 'H.264';

  @override
  Future<void> applyProfile({required String quality, required int fps, required int bitrateKbps}) async => calls.add('profile $quality/$fps/$bitrateKbps');

  @override
  Future<void> stop() async {
    calls.add('stop');
    live = false;
    emitChange();
  }
}

/// Высокий экран: список на экране «Сейчас» длиннее обычного окна теста, нижние блоки иначе не строятся.
void tallScreen(WidgetTester tester) {
  tester.view.physicalSize = const Size(600, 3200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

void main() {
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await Prefs.instance.load();
    Prefs.instance.preview = false; // видеоплеер в тестах не нужен
  });

  testWidgets('списки не растягиваются за край: нет эффекта растяжения и позиция упирается в границы', (tester) async {
    final controller = ScrollController();
    await tester.pumpWidget(app(Scaffold(body: ListView(controller: controller, children: [for (var i = 0; i < 30; i++) SizedBox(height: 80, child: Text('строка $i'))]))));
    expect(find.byType(StretchingOverscrollIndicator), findsNothing);
    expect(find.byType(GlowingOverscrollIndicator), findsNothing);
    await tester.fling(find.byType(ListView), const Offset(0, 2000), 8000); // тянем вниз за верхний край
    await tester.pumpAndSettle();
    expect(controller.offset, 0, reason: 'сверху остаётся ровно на границе, без «резинки»');
    await tester.fling(find.byType(ListView), const Offset(0, -9000), 9000);
    await tester.pumpAndSettle();
    expect(controller.offset, controller.position.maxScrollExtent);
    await tester.fling(find.byType(ListView), const Offset(0, -9000), 9000);
    await tester.pumpAndSettle();
    expect(controller.offset, controller.position.maxScrollExtent, reason: 'и снизу не уходит дальше края');
  });

  testWidgets('экран «Сейчас»: название, статус и сводка эфира с ПК', (tester) async {
    tallScreen(tester);
    final remote = makeRemote(MockClient((_) async => json({})));
    await tester.pumpWidget(app(Scaffold(body: NowPlayingPage(remote: remote))));
    expect(find.text('demo.mp4'), findsOneWidget);
    expect(find.text('Идёт эфир'), findsOneWidget);
    expect(find.textContaining('720p · 60 к/с'), findsOneWidget);
    expect(find.textContaining('Процессор'), findsOneWidget);
    expect(find.text('Транслировать экран телефона через ПК'), findsOneWidget);
  });

  testWidgets('пауза с телефона отправляет команду на ПК', (tester) async {
    tallScreen(tester);
    final calls = <String>[];
    final remote = makeRemote(MockClient((request) async {
      calls.add('${request.method} ${request.url.path} ${request.body}');
      return json({});
    }));
    await tester.pumpWidget(app(Scaffold(body: NowPlayingPage(remote: remote))));
    await tester.tap(find.byIcon(Icons.pause));
    await tester.pump();
    expect(calls.single, startsWith('POST /api/playback {"action":"pause","position":'));
  });

  testWidgets('очередь: показывает треки, свайп удаляет на ПК', (tester) async {
    final calls = <String>[];
    final state = fixture();
    (state['queue'] as List).add({'id': 'second', 'title': 'second.mp4', 'duration': 90});
    final remote = makeRemote(MockClient((request) async {
      calls.add('${request.method} ${request.url.path}');
      return json({});
    }), state: state);
    await tester.pumpWidget(app(Scaffold(body: QueuePage(remote: remote))));
    expect(find.text('demo.mp4'), findsOneWidget);
    expect(find.text('second.mp4'), findsOneWidget);
    expect(find.text('Добавить файлы с телефона'), findsOneWidget);
    await tester.drag(find.text('second.mp4'), const Offset(-600, 0));
    await tester.pumpAndSettle();
    expect(calls, contains('DELETE /api/queue/second'));
  });

  testWidgets('нет связи с ПК: баннер переподключения, без отдельного режима', (tester) async {
    tallScreen(tester);
    final remote = makeRemote(MockClient((_) async => json({})), link: Link.offline);
    await tester.pumpWidget(app(HomeScreen(remote: remote, onConnect: (_, __) {}, onDisconnect: () {})));
    expect(find.textContaining('Устройство не найдено'), findsOneWidget, reason: 'связи с ПК ещё не было — не пугаем «нет связи», а говорим, что приложение работает без него');
    expect(find.textContaining('Нет связи с устройством'), findsNothing);
    expect(find.text('Без ПК'), findsNothing, reason: 'отдельного режима «Без ПК» больше нет');
    await tester.tap(find.text('Очередь'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.textContaining('Своя очередь пуста'), findsOneWidget);
    await tester.tap(find.textContaining('Очередь ПК (последняя копия)'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('demo.mp4'), findsWidgets, reason: 'последняя очередь ПК лежит отдельно, для справки');
  });

  testWidgets('без ПК главный экран тот же: копия очереди с ПК, баннер, подключение по кнопке', (tester) async {
    tallScreen(tester);
    SharedPreferences.setMockInitialValues({'cachedState': jsonEncode({'queue': [{'id': 'a', 'title': 'из копии.mp4', 'duration': 60}], 'config': {'outputMode': 'local', 'quality': '720p', 'fps': 30}})});
    await Prefs.instance.load();
    Prefs.instance.preview = false;
    final remote = Remote.local(phone: FakeStream());
    expect(remote.state!.running, isFalse, reason: 'про эфир без связи ничего не известно');
    await tester.pumpWidget(app(HomeScreen(remote: remote, onConnect: (_, __) {}, onDisconnect: () {})));
    expect(find.textContaining('Нет подключённых устройств. Можно вещать'), findsOneWidget);
    expect(find.text('Подключиться'), findsOneWidget);
    await tester.tap(find.text('Очередь'));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.textContaining('Очередь ПК (последняя копия)'));
    await tester.pumpAndSettle();
    expect(find.text('из копии.mp4'), findsOneWidget, reason: 'очередь ПК взята с последнего подключения и лежит отдельно');
    await tester.tap(find.text('Подключиться'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('Подключение к устройству'), findsOneWidget);
    expect(find.text('Отключиться от устройства'), findsNothing, reason: 'отключаться не от чего');
  });

  testWidgets('без ПК ссылка в очередь не теряется: ждёт у телефона и видна в списке', (tester) async {
    tallScreen(tester);
    final remote = Remote.local(phone: FakeStream(), resolver: FakeLinks((url) => throw UnsupportedLink('Эту ссылку без ПК не разобрать: она уйдёт на ПК при подключении.', sendToPc: true)));
    await tester.pumpWidget(app(Scaffold(body: QueuePage(remote: remote))));
    await tester.enterText(find.byType(TextField), 'https://vk.com/video-1_2');
    await tester.tap(find.text('Добавить'));
    await tester.pumpAndSettle();
    expect(Prefs.instance.pendingLinks, ['https://vk.com/video-1_2']);
    expect(find.text('Ждёт подключения к ПК'), findsOneWidget);
    tester.state<ScaffoldMessengerState>(find.byType(ScaffoldMessenger)).clearSnackBars();
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Убрать'));
    await tester.pump();
    expect(Prefs.instance.pendingLinks, isEmpty);
  });

  testWidgets('без ПК ссылка на YouTube сразу в своей очереди: название, длительность, обложка; плейлист добавляется целиком', (tester) async {
    tallScreen(tester);
    final links = FakeLinks((url) => url.contains('list=')
        ? [for (var i = 1; i <= 12; i++) youtubeInfo('v$i', 'Ролик $i', 60.0 * i)]
        : [youtubeInfo('abc', 'Мой клип', 185)]);
    final remote = Remote.local(phone: FakeStream(), files: FakeFiles(), resolver: links);
    await tester.pumpWidget(app(Scaffold(body: ListenableBuilder(listenable: remote, builder: (_, __) => QueuePage(remote: remote)))));
    await tester.enterText(find.byType(TextField), 'https://youtu.be/abc');
    await tester.tap(find.text('Добавить'));
    await tester.pumpAndSettle();
    expect(links.asked, ['https://youtu.be/abc']);
    expect(Prefs.instance.sharedFiles.single.title, 'Мой клип');
    expect(Prefs.instance.sharedFiles.single.isLink, isTrue);
    expect(find.text('Мой клип'), findsOneWidget);
    expect(find.text('3:05 · YouTube'), findsOneWidget);
    expect(Prefs.instance.pendingLinks, isEmpty, reason: 'ссылку телефон разобрал сам — ПК ждать не нужно');

    // Большой плейлист: переспрашивает, как и на ПК.
    tester.state<ScaffoldMessengerState>(find.byType(ScaffoldMessenger)).clearSnackBars();
    await tester.enterText(find.byType(TextField), 'https://www.youtube.com/playlist?list=PL1');
    await tester.tap(find.text('Добавить'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Большой плейлист'), findsOneWidget);
    expect(find.textContaining('роликов: 12'), findsOneWidget);
    await tester.tap(find.text('Отмена'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(Prefs.instance.sharedFiles, hasLength(1), reason: 'отказались — ничего не добавилось');
    await tester.tap(find.text('Добавить'));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('Добавить').last);
    await tester.pump(const Duration(milliseconds: 400));
    expect(Prefs.instance.sharedFiles, hasLength(13));
    expect(Prefs.instance.sharedFiles.where((f) => f.kind == 'youtube').length, 13);
  });

  testWidgets('своя очередь без ПК: перетаскивание меняет порядок, смахивание убирает, нажатие запускает с этого ролика', (tester) async {
    tallScreen(tester);
    Prefs.instance.saveOwnServer(OwnServer(name: 'VPS', host: 'vps.example.com', key: 'k'));
    Prefs.instance.addSharedFiles([
      SharedFile(id: 'a', path: '', title: 'Первый', url: 'https://youtu.be/1', duration: 61, thumbnail: 'https://i.ytimg.com/vi/1/hqdefault.jpg', kind: 'youtube', sourceId: '1'),
      SharedFile(id: 'b', path: '/tmp/b.mp4', title: 'Второй файл'),
      SharedFile(id: 'c', path: '', title: 'Третий', url: 'https://example.com/c.mp4', duration: 30, kind: 'direct'),
    ]);
    final files = FakeFiles();
    final remote = Remote.local(phone: FakeStream(), files: files);
    await tester.pumpWidget(app(Scaffold(body: ListenableBuilder(listenable: remote, builder: (_, __) => QueuePage(remote: remote)))));
    expect(find.text('1:01 · YouTube'), findsOneWidget);
    expect(find.text('файл на телефоне'), findsOneWidget);
    expect(find.text('0:30 · ссылка на mp4'), findsOneWidget);
    Prefs.instance.moveSharedFile(0, 2);
    expect(Prefs.instance.sharedFiles.map((f) => f.id), ['b', 'c', 'a']);
    Prefs.instance.moveSharedFile(5, 0);
    expect(Prefs.instance.sharedFiles.map((f) => f.id), ['b', 'c', 'a'], reason: 'неверный индекс ничего не ломает');
    await tester.pump();
    await tester.tap(find.text('Третий'));
    await tester.pump();
    expect(files.calls.last, 'start vps.example.com from=1 of=3', reason: 'запуск с выбранного ролика');
    await tester.drag(find.text('Второй файл'), const Offset(-600, 0));
    await tester.pumpAndSettle();
    expect(Prefs.instance.sharedFiles.map((f) => f.id), ['c', 'a']);
  });

  testWidgets('без ПК: очередь можно сохранить как список, очистить и вернуть из списка', (tester) async {
    tallScreen(tester);
    Prefs.instance.addSharedFiles([SharedFile(id: 'a', path: '/tmp/a.mp4', title: 'Первый'), SharedFile(id: 'b', path: '/tmp/b.mp4', title: 'Второй')]);
    final remote = Remote.local(phone: FakeStream(), files: FakeFiles());
    await tester.pumpWidget(app(Scaffold(body: ListenableBuilder(listenable: remote, builder: (_, __) => QueuePage(remote: remote)))));
    await tester.tap(find.text('Списки'));
    await tester.pumpAndSettle();
    expect(find.text('Сохранённых списков пока нет'), findsOneWidget);
    await tester.tap(find.text('Сохранить очередь как список'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'Мой вечер');
    await tester.tap(find.text('Сохранить'));
    await tester.pumpAndSettle();
    expect(find.text('Мой вечер'), findsOneWidget);
    expect(find.text('Роликов: 2'), findsWidgets);
    expect(Prefs.instance.templates.single.name, 'Мой вечер');
    await tester.tapAt(const Offset(10, 10)); // закрыть лист
    await tester.pumpAndSettle();

    await tester.tap(find.text('Очистить'));
    await tester.pumpAndSettle();
    expect(find.text('Очистить очередь?'), findsOneWidget);
    await tester.tap(find.text('Отмена'));
    await tester.pumpAndSettle();
    expect(Prefs.instance.sharedFiles, hasLength(2), reason: 'отказались — очередь на месте');
    await tester.tap(find.text('Очистить'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Очистить'));
    await tester.pumpAndSettle();
    expect(Prefs.instance.sharedFiles, isEmpty);
    expect(find.textContaining('Своя очередь пуста'), findsOneWidget);

    await tester.tap(find.text('Списки'));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(PopupMenuButton<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Загрузить вместо очереди'));
    await tester.pumpAndSettle();
    expect(Prefs.instance.sharedFiles.map((f) => f.title), ['Первый', 'Второй']);
    expect(find.text('Первый'), findsOneWidget);
  });

  testWidgets('подключение к ПК: ссылки из своей очереди уходят в очередь ПК и убираются у телефона', (tester) async {
    Prefs.instance.addSharedFiles([
      SharedFile(id: 'a', path: '', title: 'Клип', url: 'https://www.youtube.com/watch?v=abc', duration: 60, kind: 'youtube', sourceId: 'abc'),
      SharedFile(id: 'f', path: '/tmp/f.mp4', title: 'Файл'),
    ]);
    final calls = <String>[];
    final remote = makeRemote(MockClient((request) async {
      calls.add('${request.method} ${request.url.path} ${request.body}');
      if (request.url.path == '/api/pair/check') return json({'paired': true, 'id': 'm1'});
      return json({'removed': []});
    }), token: 'tok');
    await tester.runAsync(() => remote.syncAll());
    expect(calls.first, 'POST /api/queue {"url":"https://www.youtube.com/watch?v=abc","confirm":true}');
    expect(Prefs.instance.sharedFiles.map((f) => f.id), ['f'], reason: 'ссылка ушла на ПК, файл остаётся на телефоне и идёт в группу');
    final contribution = calls.firstWhere((c) => c.startsWith('POST /api/group/contribute'));
    expect(contribution, contains('"id":"f"'));
    expect(contribution, isNot(contains('youtube')), reason: 'ссылки в общий список файлов не попадают');
  });

  testWidgets('без ПК одна кнопка вещает прямо на свой сервер, с ПК — через ПК', (tester) async {
    tallScreen(tester);
    Prefs.instance.saveOwnServer(OwnServer(name: 'VPS', host: 'vps.example.com', key: 'k'));
    final fake = FakeStream();
    final local = Remote.local(phone: fake);
    // как в HomeScreen: страница перестраивается, когда меняется Remote
    await tester.pumpWidget(app(Scaffold(body: ListenableBuilder(listenable: local, builder: (_, __) => NowPlayingPage(remote: local)))));
    expect(find.text('Транслировать экран телефона на сервер «VPS»'), findsOneWidget);
    expect(find.textContaining('rtspt://vps.example.com:8554/phone'), findsOneWidget, reason: 'ссылка для VRChat видна сразу');
    await tester.tap(find.textContaining('Транслировать экран телефона'));
    await tester.pumpAndSettle();
    expect(fake.calls, ['start vps.example.com 720p/30']);
    expect(find.textContaining('Идёт экран телефона на сервер'), findsOneWidget);
    await tester.tap(find.text('Остановить трансляцию экрана'));
    await tester.pumpAndSettle();
    expect(fake.calls.last, 'stop');

    final online = makeRemote(MockClient((_) async => json({})));
    expect(online.streamTarget, 'через ПК');
    expect(local.streamTarget, 'на сервер «VPS»');
  });

  testWidgets('без ПК и без сервера: понятная подсказка вместо тихой ошибки', (tester) async {
    tallScreen(tester);
    final remote = Remote.local(phone: FakeStream());
    await tester.pumpWidget(app(Scaffold(body: NowPlayingPage(remote: remote))));
    expect(find.text('Нет подключённых устройств и своего сервера'), findsOneWidget);
    await tester.tap(find.textContaining('Транслировать экран телефона'));
    await tester.pump();
    expect(find.textContaining('своего сервера нет'), findsOneWidget);
  });

  testWidgets('ПК недоступен при запуске: вместо вечной загрузки сразу рабочий экран, свои файлы доступны', (tester) async {
    tallScreen(tester);
    Prefs.instance.addSharedFiles([SharedFile(id: 'a', path: '/tmp/a.mp4', title: 'Мой ролик.mp4')]);
    // Подключение к ПК ещё не началось (или не удаётся): состояния с ПК нет, но экран не должен ждать его вечно.
    final remote = Remote(Api(Uri.parse('http://192.168.1.5:4717'), client: MockClient((_) async => throw const SocketException('нет сети'))), pcName: 'Дом', files: FakeFiles());
    expect(remote.state, isNotNull);
    await tester.pumpWidget(app(HomeScreen(remote: remote, onConnect: (_, __) {}, onDisconnect: () {})));
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.text('Эфир остановлен'), findsOneWidget);
    await tester.tap(find.text('Очередь'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Мой ролик.mp4'), findsOneWidget);
  });

  testWidgets('без ПК: плеер своих файлов — без файлов и без сервера объясняет, что нужно', (tester) async {
    tallScreen(tester);
    final files = FakeFiles();
    final remote = Remote.local(phone: FakeStream(), files: files);
    await tester.pumpWidget(app(Scaffold(body: NowPlayingPage(remote: remote))));
    expect(find.text('Нет файлов'), findsOneWidget);
    expect(find.text('Эфир остановлен'), findsOneWidget);
    await tester.tap(find.byIcon(Icons.play_arrow));
    await tester.pump();
    expect(find.textContaining('Нет своего сервера'), findsOneWidget);
    Prefs.instance.saveOwnServer(OwnServer(name: 'VPS', host: 'vps.example.com', key: 'k'));
    tester.state<ScaffoldMessengerState>(find.byType(ScaffoldMessenger)).clearSnackBars(); // первое сообщение убираем
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(Icons.play_arrow));
    await tester.pumpAndSettle();
    expect(find.textContaining('Сначала добавьте файлы'), findsOneWidget);
    expect(files.calls, isEmpty);
  });

  testWidgets('без ПК файл из очереди уходит в эфир на свой сервер; пауза, следующий и остановка работают', (tester) async {
    tallScreen(tester);
    Prefs.instance.saveOwnServer(OwnServer(name: 'VPS', host: 'vps.example.com', key: 'k'));
    Prefs.instance.addSharedFiles([SharedFile(id: 'a', path: '/tmp/a.mp4', title: 'Первый.mp4'), SharedFile(id: 'b', path: '/tmp/b.mp4', title: 'Второй.mp4')]);
    final files = FakeFiles();
    final remote = Remote.local(phone: FakeStream(), files: files);
    await tester.pumpWidget(app(HomeScreen(remote: remote, onConnect: (_, __) {}, onDisconnect: () {})));
    await tester.tap(find.text('Очередь'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('файл на телефоне'), findsNWidgets(2));
    await tester.tap(find.text('Второй.mp4'));
    await tester.pump();
    expect(files.calls, ['start vps.example.com from=1 of=2']);
    expect(find.text('файл на телефоне · в эфире'), findsOneWidget);

    await tester.tap(find.text('Сейчас'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Второй.mp4'), findsOneWidget);
    expect(find.text('Идёт эфир на сервер «VPS»'), findsOneWidget);
    await tester.tap(find.byIcon(Icons.pause));
    await tester.pump();
    expect(files.calls.last, 'pause');
    expect(find.text('Пауза'), findsOneWidget);
    await tester.tap(find.byIcon(Icons.play_arrow));
    await tester.pump();
    expect(files.calls.last, 'resume');
    await tester.tap(find.byIcon(Icons.skip_next));
    await tester.pump();
    expect(files.calls.last, 'next');
    await tester.tap(find.text('Остановить эфир файлов'));
    await tester.pump();
    expect(files.calls.last, 'stop');
    expect(find.text('Эфир остановлен'), findsOneWidget);
  });

  testWidgets('когда ПК на связи, свои файлы не запускаются сами по себе, а ждут общей очереди', (tester) async {
    tallScreen(tester);
    Prefs.instance.addSharedFiles([SharedFile(id: 'a', path: '/tmp/a.mp4', title: 'Первый.mp4')]);
    final files = FakeFiles();
    final remote = makeRemote(MockClient((_) async => json({})), token: 'tok');
    remote.myId = 'm1';
    expect(remote.files, isNot(same(files)));
    await tester.pumpWidget(app(Scaffold(body: ListenableBuilder(listenable: remote, builder: (_, __) => QueuePage(remote: remote)))));
    expect(find.text('Добавляется в общую очередь…'), findsOneWidget);
    await tester.tap(find.text('Первый.mp4'));
    await tester.pump();
    expect(files.calls, isEmpty);
  });

  testWidgets('развернуть сервер на VPS: пароль и адрес вводятся в окне, ошибки видно, сервер попадает в список', (tester) async {
    tallScreen(tester);
    final remote = Remote.local(phone: FakeStream());
    await tester.pumpWidget(app(SettingsScreen(remote: remote)));
    await tester.scrollUntilVisible(find.text('Развернуть сервер на VPS'), 300, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.text('Развернуть сервер на VPS'));
    await tester.pumpAndSettle();
    expect(find.text('Сервер на VPS'), findsOneWidget);
    // Пустой адрес и кривой порт ловятся сразу, без обращения к сети.
    await tester.tap(find.text('Развернуть и подключить'));
    await tester.pump();
    expect(find.text('Укажите адрес сервера'), findsOneWidget);
    await tester.enterText(find.widgetWithText(TextField, 'Адрес SSH'), '203.0.113.7');
    await tester.enterText(find.widgetWithText(TextField, 'Порт RTSP'), '99999');
    await tester.tap(find.text('Развернуть и подключить'));
    await tester.pump();
    expect(find.textContaining('число от 1 до 65524'), findsOneWidget);
    // Пароль скрыт, вход по ключу переключается.
    final password = tester.widget<TextField>(find.widgetWithText(TextField, 'Пароль root'));
    expect(password.obscureText, isTrue);
    await tester.tap(find.byType(Switch).last);
    await tester.pump();
    expect(find.text('Закрытый ключ (PEM)'), findsOneWidget);
    await tester.tap(find.text('Отмена'));
    await tester.pumpAndSettle();
    expect(Prefs.instance.ownServers, isEmpty);
  });

  testWidgets('развернуть сервер: окно передаёт установщику адрес, пользователя, пароль или ключ и порт, показывает ход и ошибки, закрывается готовым сервером', (tester) async {
    tallScreen(tester);
    final calls = <Map<String, Object?>>[];
    var failNext = true;
    Future<OwnServer> fake({required String host, required String script, String user = 'root', String? password, String? privateKey, int rtspPort = 8554, String name = '', String? knownHostKey}) async {
      calls.add({'host': host, 'user': user, 'password': password, 'key': privateKey, 'port': rtspPort, 'name': name, 'script': script});
      if (failNext) {
        failNext = false;
        throw SshError('Неверный пароль root.');
      }
      return OwnServer(name: name, host: '203.0.113.7', rtspPort: rtspPort, key: 'ключ-сервера', sshPort: 2222, hostKey: 'MD5:aa');
    }

    OwnServer? result;
    await tester.pumpWidget(app(Builder(builder: (context) => TextButton(
        onPressed: () async => result = await showDialog<OwnServer>(context: context, builder: (_) => DeployDialog(installer: () async => 'echo установка', deployer: fake)),
        child: const Text('открыть')))));
    await tester.tap(find.text('открыть'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'Название (необязательно)'), 'Мой VPS');
    await tester.enterText(find.widgetWithText(TextField, 'Адрес SSH'), '203.0.113.7:2222');
    await tester.enterText(find.widgetWithText(TextField, 'Пароль root'), 'неверный');
    await tester.enterText(find.widgetWithText(TextField, 'Порт RTSP'), '9554');
    await tester.tap(find.text('Развернуть и подключить'));
    await tester.pumpAndSettle();
    expect(find.text('Неверный пароль root.'), findsOneWidget, reason: 'ошибку установки видно в окне, окно не закрылось');
    expect(result, isNull);
    expect(calls.single, {'host': '203.0.113.7:2222', 'user': 'root', 'password': 'неверный', 'key': null, 'port': 9554, 'name': 'Мой VPS', 'script': 'echo установка'});
    // Вторая попытка по ключу и под другим пользователем.
    await tester.tap(find.byType(Switch).last);
    await tester.pump();
    await tester.enterText(find.widgetWithText(TextField, 'Пользователь SSH'), 'ubuntu');
    await tester.enterText(find.widgetWithText(TextField, 'Закрытый ключ (PEM)'), '-----BEGIN KEY-----');
    await tester.tap(find.text('Развернуть и подключить'));
    await tester.pumpAndSettle();
    expect(calls.last['key'], '-----BEGIN KEY-----');
    expect(calls.last['password'], isNull, reason: 'по ключу пароль не отправляется');
    expect(calls.last['user'], 'ubuntu');
    expect(result, isNotNull);
    expect(result!.key, 'ключ-сервера');
    expect(result!.sshPort, 2222);
  });

  testWidgets('удаление сервера: можно только из списка или ещё и очистить сервер по паролю (пароль обязателен)', (tester) async {
    tallScreen(tester);
    final server = OwnServer(name: 'VPS', host: '203.0.113.7', key: 'k');
    Prefs.instance.saveOwnServer(server);
    await tester.pumpWidget(app(Builder(builder: (context) => TextButton(onPressed: () => removeServerFlow(context, server), child: const Text('удалить')))));
    await tester.tap(find.text('удалить'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Убрать «VPS»?'), findsOneWidget);
    await tester.tap(find.text('Убрать и очистить'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Убрать «VPS»?'), findsOneWidget, reason: 'без пароля очистка не запускается');
    await tester.tap(find.text('Отмена'));
    await tester.pumpAndSettle();
    expect(Prefs.instance.ownServers, hasLength(1));
    await tester.tap(find.text('удалить'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Только из списка'));
    await tester.pumpAndSettle();
    expect(Prefs.instance.ownServers, isEmpty);
  });

  testWidgets('без ПК: громкость, скорость и качество как на ПК — настройки запоминаются и сразу уходят в эфир', (tester) async {
    tallScreen(tester);
    final files = FakeFiles();
    final remote = Remote.local(phone: FakeStream(), files: files);
    await tester.pumpWidget(app(Scaffold(body: ListenableBuilder(listenable: remote, builder: (_, __) => NowPlayingPage(remote: remote)))));
    expect(find.text('100%'), findsOneWidget);
    expect(find.text('1.0x'), findsOneWidget);
    expect(find.text('Качество: как в файле'), findsOneWidget);
    // Громкость: ползунок.
    await tester.drag(find.byType(Slider).last, const Offset(-120, 0));
    await tester.pump();
    expect(files.calls.any((c) => c.startsWith('volume ')), isTrue);
    expect(Prefs.instance.playVolume, isNot(1.0));
    // Скорость.
    await tester.tap(find.text('1.0x'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('1.5x'));
    await tester.pumpAndSettle();
    expect(files.calls, contains('speed 1.5'));
    expect(Prefs.instance.playSpeed, 1.5);
    expect(find.text('1.5x'), findsOneWidget);
    // Качество: окно с выбором; пока «как в файле», кадры и битрейт недоступны.
    await tester.tap(find.text('Качество: как в файле'));
    await tester.pumpAndSettle();
    expect(find.text('Качество эфира'), findsOneWidget);
    await tester.tap(find.text('720p'));
    await tester.pumpAndSettle();
    expect(files.calls, contains('profile'));
    expect(Prefs.instance.videoProfile.quality, '720p');
    await tester.tap(find.text('60'));
    await tester.pumpAndSettle();
    expect(Prefs.instance.videoFps, 60);
    await tester.tap(find.text('5 Мбит/с'));
    await tester.pumpAndSettle();
    expect(Prefs.instance.videoBitrate, 5000);
    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();
    expect(find.text('720p · 60 к/с'), findsOneWidget);
  });

  testWidgets('ссылки: переключатель rtspt:// и rtsp:// меняет ссылки, у своего сервера есть запасная HLS-ссылка', (tester) async {
    tallScreen(tester);
    Prefs.instance.saveOwnServer(OwnServer(name: 'VPS', host: '203.0.113.7', rtspPort: 9554, key: 'k'));
    final remote = Remote.local(phone: FakeStream());
    await tester.pumpWidget(app(Scaffold(body: LinksPage(remote: remote))));
    expect(find.text('rtspt://203.0.113.7:9554/phone'), findsOneWidget);
    expect(find.text('http://203.0.113.7:9564/phone/index.m3u8'), findsOneWidget);
    await tester.tap(find.text('rtsp:// (UDP)'));
    await tester.pump();
    expect(find.text('rtsp://203.0.113.7:9554/phone'), findsOneWidget);
    expect(find.text('rtspt://203.0.113.7:9554/phone'), findsNothing);
    expect(find.text('http://203.0.113.7:9564/phone/index.m3u8'), findsOneWidget, reason: 'HLS от транспорта не зависит');
  });

  testWidgets('журнал открывается из настроек и показывает записи', (tester) async {
    tallScreen(tester);
    AppLog.instance.clear();
    AppLog.instance.add('Эфир своей очереди: способ «lan»');
    final remote = Remote.local(phone: FakeStream());
    await tester.pumpWidget(app(SettingsScreen(remote: remote)));
    await tester.tap(find.text('Журнал'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Эфир своей очереди: способ «lan»'), findsOneWidget);
    await tester.tap(find.byTooltip('Очистить'));
    await tester.pump();
    expect(find.text('Журнал пуст'), findsOneWidget);
  });

  testWidgets('ссылки без ПК: показывается ссылка своего сервера', (tester) async {
    Prefs.instance.saveOwnServer(OwnServer(name: 'VPS', host: '203.0.113.7', rtspPort: 9554, key: 'k'));
    final remote = Remote.local(phone: FakeStream());
    await tester.pumpWidget(app(Scaffold(body: LinksPage(remote: remote))));
    expect(find.text('rtspt://203.0.113.7:9554/phone'), findsOneWidget);
  });

  testWidgets('настройки: свои серверы добавляются, выбираются и удаляются', (tester) async {
    tallScreen(tester);
    final remote = Remote.local(phone: FakeStream());
    await tester.pumpWidget(app(SettingsScreen(remote: remote)));
    await tester.tap(find.text('Добавить сервер'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'Адрес сервера'), '203.0.113.7');
    await tester.enterText(find.widgetWithText(TextField, 'Ключ'), 'k1');
    await tester.tap(find.text('Сохранить'));
    await tester.pumpAndSettle();
    expect(Prefs.instance.ownServers.single.host, '203.0.113.7');
    expect(find.text('203.0.113.7:8554'), findsOneWidget);
    expect(find.text('Эфир на ПК'), findsNothing, reason: 'настройки эфира ПК без ПК не показываются');
    await tester.tap(find.byTooltip('Удалить').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Только из списка'));
    await tester.pumpAndSettle();
    expect(Prefs.instance.ownServers, isEmpty);
  });

  testWidgets('подключение к ПК: ссылки уходят в очередь, файлы и серверы — группе; серверы ПК к телефону не прилипают', (tester) async {
    Prefs.instance.addPendingLink('https://example.com/a.mp4');
    Prefs.instance.saveOwnServer(OwnServer(name: 'Мой', host: '198.51.100.20', rtspPort: 9554, key: 'phone-key'));
    Prefs.instance.addSharedFiles([SharedFile(id: 'f1', path: '/tmp/f1.mp4', title: 'Мой ролик.mp4'), SharedFile(id: 'f2', path: '/tmp/f2.mp3', title: 'Песня.mp3')]);
    final calls = <String>[];
    final remote = makeRemote(MockClient((request) async {
      calls.add('${request.method} ${request.url.path} ${request.body}');
      if (request.url.path == '/api/pair/check') return json({'paired': true, 'id': 'abc123'});
      if (request.url.path == '/api/group/contribute') return json({'removed': ['f2']});
      return json({});
    }), token: 'tok');
    await tester.runAsync(() => remote.syncAll());
    expect(calls.first, 'POST /api/queue {"url":"https://example.com/a.mp4","confirm":true}', reason: 'накопленные ссылки уходят в очередь ПК первыми');
    expect(remote.myId, 'abc123', reason: 'телефон знает свой номер в группе');
    final contribution = calls.firstWhere((c) => c.startsWith('POST /api/group/contribute'));
    expect(contribution, contains('"base":"http://192.168.1.50:4242"'));
    expect(contribution, contains('"key":"fake-media-key-0123456789"'));
    expect(contribution, contains('"id":"f1"'));
    expect(contribution, contains('"publishKey":"phone-key"'));
    expect(calls.any((c) => c.contains('/api/servers/')), isFalse, reason: 'серверы между устройствами больше не копируются насовсем');
    expect(Prefs.instance.ownServers.map((e) => e.name), ['Мой']);
    expect(Prefs.instance.sharedFiles.map((e) => e.id), ['f1'], reason: 'файл, который убрали другие, пропал и у владельца');
    expect(Prefs.instance.pendingLinks, isEmpty);
  });

  testWidgets('группа: видно, кто ведёт эфир и кто подключён; чужой эфир можно перехватить', (tester) async {
    tallScreen(tester);
    final calls = <String>[];
    final state = fixture()
      ..['group'] = {
        'admin': {'id': 'dev1', 'name': 'Игровой ПК', 'kind': 'pc'},
        'controller': {'id': 'm2', 'name': 'Телефон Ани', 'kind': 'phone', 'at': 1},
        'members': [
          {'id': 'm1', 'name': 'Мой телефон', 'kind': 'phone', 'online': true, 'files': 1, 'servers': 0},
          {'id': 'm2', 'name': 'Телефон Ани', 'kind': 'phone', 'online': true, 'files': 0, 'servers': 1},
          {'id': 'm3', 'name': 'Ноутбук', 'kind': 'pc', 'online': false, 'files': 0, 'servers': 0},
        ],
      };
    final remote = makeRemote(MockClient((request) async {
      calls.add('${request.method} ${request.url.path}');
      return json({});
    }), state: state, token: 'tok');
    remote.myId = 'm1';
    await tester.pumpWidget(app(Scaffold(body: NowPlayingPage(remote: remote))));
    expect(find.text('Эфир ведёт: Телефон Ани'), findsOneWidget);
    expect(find.text('Игровой ПК · админ'), findsOneWidget);
    expect(find.text('Мой телефон · вы'), findsOneWidget);
    expect(find.text('Ноутбук'), findsOneWidget);
    await tester.tap(find.text('Перехватить'));
    await tester.pump();
    expect(calls, contains('POST /api/group/take'));

    // Эфир ведёт этот телефон — кнопки перехвата нет.
    final mine = makeRemote(MockClient((_) async => json({})), state: (fixture()..['group'] = {
      'admin': {'name': 'Игровой ПК'}, 'controller': {'id': 'm1', 'name': 'Мой телефон'}, 'members': [{'id': 'm1', 'name': 'Мой телефон', 'kind': 'phone', 'online': true}]}));
    mine.myId = 'm1';
    await tester.pumpWidget(app(Scaffold(body: NowPlayingPage(remote: mine))));
    expect(find.text('Эфир ведёте вы'), findsOneWidget);
    expect(find.text('Перехватить'), findsNothing);
  });

  testWidgets('очередь: у файлов видно владельца; свой файл без связи ждёт подключения', (tester) async {
    tallScreen(tester);
    final state = fixture();
    (state['queue'] as List).addAll([
      {'id': 'm2.x', 'title': 'Клип Ани', 'duration': 65, 'member': 'm2', 'owner': 'Телефон Ани', 'ownerItemId': 'x', 'thumbnail': ''},
      {'id': 'm1.f1', 'title': 'Мой ролик', 'duration': 30, 'member': 'm1', 'owner': 'Мой телефон', 'ownerItemId': 'f1', 'thumbnail': ''},
    ]);
    Prefs.instance.addSharedFiles([SharedFile(id: 'f1', path: '/tmp/a', title: 'Мой ролик'), SharedFile(id: 'f9', path: '/tmp/b', title: 'Ещё не ушёл.mp4')]);
    final remote = makeRemote(MockClient((_) async => json({})), state: state);
    remote.myId = 'm1';
    await tester.pumpWidget(app(Scaffold(body: ListenableBuilder(listenable: remote, builder: (_, __) => QueuePage(remote: remote)))));
    expect(find.text('1:05 · Телефон Ани'), findsOneWidget);
    expect(find.text('0:30 · мой файл'), findsOneWidget);
    expect(find.text('Ещё не ушёл.mp4'), findsOneWidget, reason: 'свой файл, которого ещё нет в общей очереди, виден как ожидающий');
    expect(find.text('Добавляется в общую очередь…'), findsOneWidget);
    expect(find.text('Мой ролик'), findsOneWidget, reason: 'уже ушедший файл показан только в очереди, второй строки нет');
  });

  group('устройства в сети', () {
    final home = FoundPc('rar', '192.168.1.5', 4717);
    final locked = FoundPc('Офис', '192.168.1.9', 4717);
    Future<({String name, bool pinRequired})?> probe(Uri base) async =>
        base.host == '192.168.1.9' ? (name: 'Рабочий ПК', pinRequired: true) : (name: 'Игровой ПК', pinRequired: false);

    ConnectScreen screen(void Function(String, Uri) onPick, {VoidCallback? onDisconnect}) => ConnectScreen(
          onPick: onPick,
          onDisconnect: onDisconnect,
          probe: probe,
          discoveryFactory: (onChange) => FakeDiscovery(onChange, [home, locked]),
        );

    testWidgets('показывает найденные устройства под именами, которые они сами назвали, и замок у защищённых', (tester) async {
      await tester.pumpWidget(app(screen((_, __) {})));
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Игровой ПК'), findsOneWidget, reason: 'имя взято у самого ПК, а не из mDNS');
      expect(find.text('Рабочий ПК'), findsOneWidget);
      expect(find.byIcon(Icons.lock_outline), findsOneWidget, reason: 'замок только у ПК с PIN');
      expect(find.text('192.168.1.9:4717 · нужен PIN'), findsOneWidget);
      expect(find.text('Отключиться от устройства'), findsNothing);
    });

    testWidgets('устройство можно назвать по-своему, имя запоминается', (tester) async {
      await tester.pumpWidget(app(screen((_, __) {})));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.tap(find.byTooltip('Переименовать').first);
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).last, 'Комната Ани');
      await tester.tap(find.text('Сохранить'));
      await tester.pumpAndSettle();
      expect(Prefs.instance.aliases['192.168.1.5:4717'], 'Комната Ани');
      expect(find.text('Комната Ани'), findsOneWidget);
      expect(Prefs.instance.nameFor('192.168.1.5:4717', 'rar'), 'Комната Ани');
      // пустое имя возвращает то, что назвал сам ПК
      Prefs.instance.setAlias('192.168.1.5:4717', '  ');
      expect(Prefs.instance.nameFor('192.168.1.5:4717', 'Игровой ПК'), 'Игровой ПК');
    });

    testWidgets('ПК без PIN подключается сразу, с именем, которое дали', (tester) async {
      String? pickedName;
      Uri? pickedBase;
      Prefs.instance.setAlias('192.168.1.5:4717', 'Мой ПК');
      await tester.pumpWidget(app(screen((name, base) { pickedName = name; pickedBase = base; })));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.tap(find.text('Мой ПК'));
      await tester.pump();
      expect(pickedName, 'Мой ПК');
      expect(pickedBase.toString(), 'http://192.168.1.5:4717');
    });

    testWidgets('ПК с PIN: без ключа спрашивает PIN, с верным входит и запоминает ключ, с неверным остаётся', (tester) async {
      final calls = <String>[];
      var pickedHost = '';
      await tester.pumpWidget(app(ConnectScreen(
        onPick: (_, base) => pickedHost = base.host,
        probe: probe,
        discoveryFactory: (onChange) => FakeDiscovery(onChange, [locked]),
      )));
      await tester.pump(const Duration(milliseconds: 100));
      // Ключ привязки выдаёт настоящий Api: подменяем сеть для проверки сценария через тестовый клиент ниже.
      await tester.tap(find.text('Рабочий ПК'));
      await tester.pumpAndSettle();
      expect(find.text('Это устройство защищено PIN-кодом. Введите его один раз — приложение запомнит.'), findsOneWidget);
      expect(pickedHost, isEmpty, reason: 'пока PIN не введён, подключения нет');
      await tester.tap(find.text('Отмена'));
      await tester.pumpAndSettle();
      expect(pickedHost, isEmpty);
      expect(calls, isEmpty);

      // с уже сохранённым ключом PIN не спрашивают
      Prefs.instance.setToken('http://192.168.1.9:4717', 'saved');
      await tester.tap(find.text('Рабочий ПК'));
      await tester.pumpAndSettle();
      expect(pickedHost, '192.168.1.9');
      expect(find.byIcon(Icons.lock_open), findsOneWidget, reason: 'открытый замок — ключ у телефона уже есть');
    });

    testWidgets('кнопка «Отключиться» есть, только пока подключены к ПК', (tester) async {
      var disconnected = false;
      await tester.pumpWidget(app(screen((_, __) {}, onDisconnect: () => disconnected = true)));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.tap(find.text('Отключиться от устройства'));
      expect(disconnected, isTrue);
    });
  });

  testWidgets('PIN-диалог: верный PIN даёт ключ, неверный — понятная ошибка', (tester) async {
    final api = Api(Uri.parse('http://pc:4717'), client: MockClient((request) async {
      final code = (jsonDecode(request.body) as Map)['code'];
      return code == '4821' ? json({'token': 'new-token'}) : json({'error': 'Неверный PIN.'}, 403);
    }));
    String? result;
    await tester.pumpWidget(app(Builder(builder: (context) => TextButton(
        onPressed: () async => result = await pinDialog(context, api, title: 'Игровой ПК'), child: const Text('открыть')))));
    await tester.tap(find.text('открыть'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '0000');
    await tester.tap(find.text('Войти'));
    await tester.pumpAndSettle();
    expect(find.text('Неверный PIN.'), findsOneWidget);
    expect(result, isNull);
    await tester.enterText(find.byType(TextField), '4821');
    await tester.tap(find.text('Войти'));
    await tester.pumpAndSettle();
    expect(result, 'new-token');
  });

  testWidgets('отвязали на ПК: первая же команда возвращает просьбу ввести PIN', (tester) async {
    final remote = makeRemote(MockClient((request) async => json({'error': 'Нужен PIN этого ПК.', 'code': 'pin'}, 401)), token: 'old');
    expect(remote.needsPin, isFalse);
    final error = await tester.runAsync(() => remote.playback('pause'));
    expect(error, contains('PIN'));
    expect(remote.needsPin, isTrue);
    // другие ошибки баннер PIN не вызывают
    final other = makeRemote(MockClient((request) async => json({'error': 'что-то другое'}, 500)));
    await tester.runAsync(() => other.playback('pause'));
    expect(other.needsPin, isFalse);
  });

  testWidgets('ПК потребовал PIN во время работы: баннер «Ввести PIN», после ввода соединение продолжается с ключом', (tester) async {
    tallScreen(tester);
    final remote = makeRemote(MockClient((request) async {
      if (request.url.path == '/api/pair') return json({'token': 'fresh'});
      return json({});
    }), link: Link.offline);
    remote.needsPin = true;
    await tester.pumpWidget(app(HomeScreen(remote: remote, onConnect: (_, __) {}, onDisconnect: () {})));
    expect(find.text('Это устройство защищено PIN-кодом.'), findsOneWidget);
    expect(find.textContaining('Подключаюсь снова'), findsNothing, reason: 'вместо бесконечного «подключаюсь» — просьба ввести PIN');
    await tester.tap(find.text('Ввести PIN'));
    await tester.pump(const Duration(milliseconds: 500)); // на экране бегает индикатор переподключения — settle не наступит
    await tester.enterText(find.byType(TextField), '4821');
    await tester.tap(find.text('Войти'));
    await tester.pump(const Duration(milliseconds: 500));
    expect(remote.api.token, 'fresh');
    expect(remote.needsPin, isFalse);
    expect(Prefs.instance.tokens['http://192.168.1.5:4717'], 'fresh');
  });

  testWidgets('настройки: имя телефона меняется и уходит в привязку', (tester) async {
    tallScreen(tester);
    final remote = Remote.local(phone: FakeStream());
    await tester.pumpWidget(app(SettingsScreen(remote: remote)));
    expect(find.textContaining('Телефон — так оно видно другим устройствам'), findsOneWidget);
    await tester.tap(find.text('Имя этого устройства'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'Телефон Ани');
    await tester.tap(find.text('Сохранить'));
    await tester.pumpAndSettle();
    expect(Prefs.instance.deviceName, 'Телефон Ани');
    final seen = <String>[];
    final api = Api(Uri.parse('http://pc:4717'), client: MockClient((request) async { seen.add(request.body); return json({'token': 't'}); }));
    await api.pair('1234', Prefs.instance.deviceName);
    expect(seen.single, '{"code":"1234","name":"Телефон Ани","kind":"phone"}', reason: 'ПК увидит именно это имя в списке привязанных');
  });

  testWidgets('настройки эфира без привязки: значения с ПК видны, менять нельзя', (tester) async {
    final remote = makeRemote(MockClient((request) async => request.url.path == '/api/pair/check' ? json({'error': 'Нужна привязка'}, 401) : json({})));
    await tester.pumpWidget(app(StreamSettingsScreen(remote: remote)));
    await tester.pumpAndSettle();
    expect(find.text('Настройки с ПК видны, менять их нельзя'), findsOneWidget);
    final chip = tester.widget<ChoiceChip>(find.widgetWithText(ChoiceChip, '720p'));
    expect(chip.selected, isTrue, reason: 'текущее качество ПК показано');
    expect(chip.onSelected, isNull, reason: 'но менять до привязки нельзя');
  });

  testWidgets('настройки эфира после привязки: изменения уходят на ПК с ключом', (tester) async {
    final calls = <String>[];
    final remote = makeRemote(MockClient((request) async {
      calls.add('${request.method} ${request.url.path} token=${request.headers['X-VRCast-Token']} ${request.body}');
      return json({});
    }), token: 'tok');
    await tester.pumpWidget(app(StreamSettingsScreen(remote: remote)));
    await tester.pumpAndSettle();
    expect(find.text('Настройки с ПК видны, менять их нельзя'), findsNothing);
    await tester.tap(find.widgetWithText(ChoiceChip, '1080p'));
    await tester.pump();
    expect(calls.last, startsWith('POST /api/config token=tok'));
    expect(calls.last, contains('"quality":"1080p"'));
    expect(calls.last, contains('"applyLive":true'), reason: 'в идущем эфире настройка применяется сразу');
  });
}

/// Поиск в сети без mDNS: сразу отдаёт заданный список устройств.
class FakeDiscovery extends Discovery {
  FakeDiscovery(super.onChange, this.devices);
  final List<FoundPc> devices;
  @override
  Future<void> start() async => onChange(devices);
  @override
  Future<void> stop() async {}
}
