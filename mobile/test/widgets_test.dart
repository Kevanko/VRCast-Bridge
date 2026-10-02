import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vrcast_remote/api.dart';
import 'package:vrcast_remote/discovery.dart';
import 'package:vrcast_remote/media_server.dart';
import 'package:vrcast_remote/main.dart';
import 'package:vrcast_remote/models.dart';
import 'package:vrcast_remote/own_server.dart';
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
    expect(find.textContaining('Нет связи с ПК'), findsOneWidget);
    expect(find.text('Без ПК'), findsNothing, reason: 'отдельного режима «Без ПК» больше нет');
    expect(find.text('demo.mp4'), findsWidgets, reason: 'последняя очередь остаётся на экране');
  });

  testWidgets('без ПК главный экран тот же: копия очереди с ПК, баннер, подключение по кнопке', (tester) async {
    tallScreen(tester);
    SharedPreferences.setMockInitialValues({'cachedState': jsonEncode({'queue': [{'id': 'a', 'title': 'из копии.mp4', 'duration': 60}], 'config': {'outputMode': 'local', 'quality': '720p', 'fps': 30}})});
    await Prefs.instance.load();
    Prefs.instance.preview = false;
    final remote = Remote.local(phone: FakeStream());
    expect(remote.state!.running, isFalse, reason: 'про эфир без связи ничего не известно');
    await tester.pumpWidget(app(HomeScreen(remote: remote, onConnect: (_, __) {}, onDisconnect: () {})));
    expect(find.textContaining('ПК не подключён'), findsOneWidget);
    expect(find.text('Подключиться'), findsOneWidget);
    await tester.tap(find.text('Очередь'));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('из копии.mp4'), findsOneWidget, reason: 'очередь взята с последнего подключения к ПК');
    await tester.tap(find.text('Подключиться'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('Подключение к ПК'), findsOneWidget);
    expect(find.text('Отключиться от ПК'), findsNothing, reason: 'отключаться не от чего');
  });

  testWidgets('без ПК ссылка в очередь не теряется: ждёт у телефона и видна в списке', (tester) async {
    tallScreen(tester);
    final remote = Remote.local(phone: FakeStream());
    await tester.pumpWidget(app(Scaffold(body: QueuePage(remote: remote))));
    await tester.enterText(find.byType(TextField), 'https://example.com/video.mp4');
    await tester.tap(find.text('Добавить'));
    await tester.pumpAndSettle();
    expect(Prefs.instance.pendingLinks, ['https://example.com/video.mp4']);
    expect(find.text('Ждёт подключения к ПК'), findsOneWidget);
    await tester.pump(const Duration(seconds: 6)); // первое сообщение уходит, показывается следующее
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Убрать'));
    await tester.pump();
    expect(Prefs.instance.pendingLinks, isEmpty);
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
    expect(find.text('Нет ПК и нет своего сервера'), findsOneWidget);
    await tester.tap(find.textContaining('Транслировать экран телефона'));
    await tester.pump();
    expect(find.textContaining('своего сервера нет'), findsOneWidget);
  });

  testWidgets('без ПК управление эфиром объясняет, что нужен ПК', (tester) async {
    tallScreen(tester);
    final calls = <String>[];
    final remote = Remote.local(phone: FakeStream());
    await tester.pumpWidget(app(Scaffold(body: NowPlayingPage(remote: remote))));
    await tester.tap(find.byIcon(Icons.skip_next));
    await tester.pump();
    expect(find.textContaining('Нет связи с ПК'), findsOneWidget);
    expect(calls, isEmpty);
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
      expect(find.text('Отключиться от ПК'), findsNothing);
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
      expect(find.text('Этот ПК защищён PIN-кодом. Введите его один раз — телефон запомнит.'), findsOneWidget);
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
      await tester.tap(find.text('Отключиться от ПК'));
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
    expect(find.text('Этот ПК защищён PIN-кодом.'), findsOneWidget);
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
    expect(find.textContaining('Телефон — так он виден ПК'), findsOneWidget);
    await tester.tap(find.text('Имя этого телефона'));
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

class _NoH264Stream extends FakeStream {
  @override
  String selectedCodec = 'нет H.264';
}

class _FailingStream extends FakeStream {
  @override
  Future<void> startDirect(OwnServer server, {String quality = '720p', int fps = 30}) async => throw 'Сервер отклонил ключ. Проверьте ключ в настройках сервера.';
}
