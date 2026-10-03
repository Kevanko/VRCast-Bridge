import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

/// Откуда читаются байты ролика: файл на телефоне или адрес в сети (YouTube и прямые ссылки). Кадры берутся по смещениям,
/// поэтому нужен произвольный доступ.
abstract class ByteSource {
  Future<int> length();
  Future<Uint8List> read(int offset, int length);
  Future<void> close();
}

class FileSource implements ByteSource {
  FileSource(this.path);
  final String path;
  RandomAccessFile? _file;

  Future<RandomAccessFile> _open() async => _file ??= await File(path).open();

  @override
  Future<int> length() async => (await _open()).length();

  @override
  Future<Uint8List> read(int offset, int length) async {
    final file = await _open();
    await file.setPosition(offset);
    return file.read(length);
  }

  @override
  Future<void> close() async {
    final file = _file;
    _file = null;
    await file?.close();
  }
}

/// Чтение по сети кусками (HTTP Range) с запасом вперёд: эфиру нужен ровный поток, а не остановка на каждом запросе.
class HttpSource implements ByteSource {
  HttpSource(this.url, {this.blockSize = 256 * 1024, this.keep = 12, this.hedgeAfter = const Duration(seconds: 3), HttpClient? client}) : _client = client ?? (HttpClient()..connectionTimeout = const Duration(seconds: 6));

  final Uri url;
  final int blockSize;
  final int keep;
  final Duration hedgeAfter;
  final HttpClient _client;
  int? _length;
  final _blocks = <int, Uint8List>{};
  final _loading = <int, Future<Uint8List>>{};
  bool _closed = false;

  @override
  Future<int> length() async {
    if (_length == null) await _block(0);
    return _length!;
  }

  Future<Uint8List> _block(int index) {
    final ready = _blocks[index];
    if (ready != null) return Future.value(ready);
    // Не возвращать значение из whenComplete: remove отдаёт тот же Future, и он ждал бы сам себя.
    return _loading[index] ??= _fetch(index).whenComplete(() {
      _loading.remove(index);
    });
  }

  Future<Uint8List> _fetch(int index) async {
    Object? last;
    for (var round = 0; round < 3 && !_closed; round++) {
      try {
        final got = await _race(index);
        _length ??= got.$2;
        _blocks[index] = got.$1;
        while (_blocks.length > keep) {
          _blocks.remove(_blocks.keys.reduce((a, b) => (a - index).abs() > (b - index).abs() ? a : b));
        }
        return got.$1;
      } catch (e) {
        last = e;
        await Future<void>.delayed(Duration(milliseconds: 300 * (round + 1)));
      }
    }
    throw last ?? const HttpException('Источник закрыт');
  }

  /// Один кусок с подстраховкой: не ответил за [hedgeAfter] (зависшее соединение на слабой сети) — запрашиваем ещё раз
  /// рядом, побеждает тот, кто ответил первым. Упавший запрос тут же заменяется вторым.
  Future<(Uint8List, int?)> _race(int index) {
    final done = Completer<(Uint8List, int?)>();
    var started = 0, failed = 0;
    Timer? hedge;
    void launch() {
      started++;
      _once(index).then((value) {
        hedge?.cancel();
        if (!done.isCompleted) done.complete(value);
      }, onError: (Object e, StackTrace trace) {
        failed++;
        if (done.isCompleted) return;
        if (started < 2) {
          hedge?.cancel();
          launch();
        } else if (failed >= started) {
          hedge?.cancel();
          done.completeError(e, trace);
        }
      });
    }

    launch();
    hedge = Timer(hedgeAfter, () {
      if (!done.isCompleted && started < 2) launch();
    });
    return done.future;
  }

  /// Один запрос куска. Возвращает байты и полный размер файла, если сервер его назвал.
  Future<(Uint8List, int?)> _once(int index) async {
    final start = index * blockSize;
    final request = await _client.getUrl(url);
    request.headers.set(HttpHeaders.rangeHeader, 'bytes=$start-${start + blockSize - 1}');
    final response = await request.close().timeout(const Duration(seconds: 12));
    if (response.statusCode != 206 && response.statusCode != 200) {
      await response.drain<void>();
      throw HttpException('Сервер ответил ${response.statusCode}', uri: url);
    }
    final body = BytesBuilder(copy: false);
    await for (final chunk in response.timeout(const Duration(seconds: 15))) {
      body.add(chunk);
    }
    var bytes = body.takeBytes();
    final whole = bytes.length;
    // Сервер проигнорировал Range и отдал файл с начала: берём нужный кусок из него.
    if (response.statusCode == 200 && start > 0) bytes = start >= whole ? Uint8List(0) : Uint8List.sublistView(bytes, start, start + blockSize > whole ? whole : start + blockSize);
    if (bytes.length > blockSize) bytes = Uint8List.sublistView(bytes, 0, blockSize);
    final range = response.headers.value(HttpHeaders.contentRangeHeader);
    final total = range == null ? null : int.tryParse(range.split('/').last);
    return (bytes, total ?? (response.statusCode == 200 ? whole : null));
  }

  @override
  Future<Uint8List> read(int offset, int length) async {
    final out = BytesBuilder(copy: false);
    var at = offset;
    final end = offset + length;
    while (at < end) {
      final index = at ~/ blockSize;
      final block = await _block(index);
      final from = at - index * blockSize;
      if (from >= block.length) break; // конец файла
      final take = (end - at) < block.length - from ? end - at : block.length - from;
      out.add(Uint8List.sublistView(block, from, from + take));
      at += take;
    }
    // Следующий кусок грузим заранее.
    final next = (offset + length) ~/ blockSize + 1;
    final size = _length;
    if (!_closed && (size == null || next * blockSize < size) && !_blocks.containsKey(next)) unawaited(_block(next).then((_) {}, onError: (_) {}));
    return out.takeBytes();
  }

  @override
  Future<void> close() async {
    _closed = true;
    _client.close(force: true);
  }
}
