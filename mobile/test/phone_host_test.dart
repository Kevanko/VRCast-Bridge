import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vrcast_remote/api.dart';
import 'package:vrcast_remote/broadcaster.dart';
import 'package:vrcast_remote/byte_source.dart';
import 'package:vrcast_remote/file_broadcast.dart';
import 'package:vrcast_remote/links.dart';
import 'package:vrcast_remote/media_server.dart';
import 'package:vrcast_remote/own_server.dart';
import 'package:vrcast_remote/phone_host.dart';
import 'package:vrcast_remote/remote.dart';

class _Links implements LinkResolver {
  @override
  Future<List<LinkInfo>> inspect(String raw) async => [LinkInfo(url: raw, title: 'Ролик', duration: 42, thumbnail: '', kind: 'direct')];
  @override
  Future<ByteSource> open(SharedFile item) => throw UnsupportedError('не нужно');
}

void main() {
  late PhoneHost host;
  late Broadcaster broadcaster;
  late Api api;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await Prefs.instance.load();
    Prefs.instance.update(() {
      Prefs.instance.deviceName = 'Телефон-админ';
      Prefs.instance.hostDevices = [];
      Prefs.instance.sharedFiles = [SharedFile(id: 'own1', path: '/x/own.mp4', title: 'Мой ролик')];
    });
    broadcaster = Broadcaster(files: FileBroadcast(hold: null), resolver: _Links());
    host = PhoneHost(broadcaster: broadcaster, graceMs: 300, heartbeat: const Duration(milliseconds: 100), advertise: false);
    final port = await host.start(port: 0);
    api = Api(Uri.parse('http://127.0.0.1:$port'));
  });
  tearDown(() async {
    await host.stop();
    broadcaster.dispose();
  });

  Future<Api> paired(String name, {String kind = 'phone'}) async {
    final token = await Api(api.base).pair(host.pairCode, name);
    return Api(api.base, token: token);
  }

  test('lan-info: устройство называет себя, код привязки одноразовый', () async {
    final info = await api.lanInfo();
    expect(info['name'], 'Телефон-админ');
    expect(info['kind'], 'phone');
    await expectLater(Api(api.base).pair('000000', 'Чужой'), throwsA(isA<ApiException>()));
    final first = host.pairCode;
    final member = await paired('ПК друга');
    expect(host.pairCode, isNot(first), reason: 'код меняется после каждой привязки');
    expect(await member.pairCheck(), isTrue);
    expect(await api.pairCheck(), isFalse);
    expect(Prefs.instance.hostDevices.single.name, 'ПК друга');
  });

  test('участник отдаёт файлы и серверы, админ видит их в общей очереди и убирает чужой файл', () async {
    final member = await paired('Телефон Б');
    final id = await member.myId();
    final removed = await member.contribute(
      mediaBase: 'http://127.0.0.1:5555',
      mediaKey: 'abcdefghijklmnopqrstuvwx',
      files: [
        {'id': 'f1', 'title': 'Файл Б'},
        {'id': 'f2', 'title': 'Другой'}
      ],
      servers: [OwnServer(name: 'VPS Б', host: 'vps.example', key: 'k')],
    );
    expect(removed, isEmpty);
    final state = await api.status();
    expect(state.queue.map((e) => e.title), ['Мой ролик', 'Файл Б', 'Другой']);
    expect(state.queue[1].owner, 'Телефон Б');
    expect(state.queue[1].id, '$id.f1');
    expect(state.servers.any((s) => s.owner == 'Телефон Б'), isTrue);
    expect(broadcaster.extraFiles.first.url, 'http://127.0.0.1:5555/api/media/f1?k=abcdefghijklmnopqrstuvwx');
    expect(state.group.members.single.files, 2);

    await api.removeFromQueue('$id.f1');
    final again = await member.contribute(mediaBase: 'http://127.0.0.1:5555', mediaKey: 'abcdefghijklmnopqrstuvwx', files: [
      {'id': 'f1', 'title': 'Файл Б'},
      {'id': 'f2', 'title': 'Другой'}
    ], servers: const []);
    expect(again, ['f1']);
    expect((await api.status()).queue.map((e) => e.title), ['Мой ролик', 'Другой']);
  });

  test('чужой адрес в ссылке на файлы отвергается: админ не ходит куда укажут', () async {
    final member = await paired('Хитрый');
    await member.contribute(mediaBase: 'http://10.9.9.9:80', mediaKey: 'abcdefghijklmnopqrstuvwx', files: [
      {'id': 'f1', 'title': 'Файл'}
    ], servers: const []);
    expect((await api.status()).queue.map((e) => e.title), ['Мой ролик']);
  });

  test('без привязки группа закрыта, а управление эфиром и ссылки открыты как на ПК', () async {
    await expectLater(api.contribute(mediaBase: 'http://127.0.0.1:1', mediaKey: 'abcdefghijklmnopqrstuvwx', files: const [], servers: const []), throwsA(isA<ApiException>()));
    final added = await api.addLink('https://example.com/a.mp4');
    expect(added['added'], 1);
    expect(Prefs.instance.sharedFiles.map((f) => f.title), contains('Ролик'));
    await api.playback('loop', {'mode': 'all'});
    expect(broadcaster.files.loopMode, 'all');
    expect((await api.status()).queue.length, 2);
  });

  test('участник в сети по потоку событий; отключился — через паузу его файлы пропадают; перехват эфира', () async {
    final member = await paired('Телефон В');
    await member.contribute(mediaBase: 'http://127.0.0.1:5555', mediaKey: 'abcdefghijklmnopqrstuvwx', files: [
      {'id': 'f1', 'title': 'Файл В'}
    ], servers: const []);
    final events = member.events().listen((_) {});
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect((await api.status()).group.members.single.online, isTrue);
    await member.take();
    expect((await api.status()).group.controllerName, 'Телефон В');

    await events.cancel();
    await Future<void>.delayed(const Duration(milliseconds: 1500));
    final after = await api.status();
    expect(after.queue.map((e) => e.title), ['Мой ролик']);
    expect(after.group.members.single.online, isFalse);
    expect(after.group.members.single.name, 'Телефон В', reason: 'привязка остаётся, пропадают только файлы');
  });

  test('отвязать: устройство теряет доступ', () async {
    final member = await paired('Лишний');
    host.unpair(Prefs.instance.hostDevices.single.id);
    expect(await member.pairCheck(), isFalse);
  });
}
