import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

/// Запись в сокет одним потоком с очередью. В Dart `Socket.add` во время `flush` бросает ошибку «Bad state»,
/// а эфиру нужно писать из разных мест (кадры, отчёты, пинги). Здесь данные копятся в очереди и уходят порциями;
/// размер очереди показывает, насколько получатель отстаёт.
class SocketWriter {
  SocketWriter(this.socket, {this.onFailure});

  final Socket socket;
  final void Function()? onFailure;
  final _pending = BytesBuilder(copy: false);
  bool _writing = false;
  bool _failed = false;
  final _waiting = <Completer<void>>[];

  /// Сколько байт ещё не ушло к получателю.
  int get backlog => _pending.length;
  bool get failed => _failed;

  void add(List<int> bytes) {
    if (_failed) return;
    _pending.add(bytes);
    if (_writing) return;
    _writing = true;
    unawaited(_drain());
  }

  Future<void> _drain() async {
    try {
      while (_pending.length > 0) {
        final bytes = _pending.takeBytes();
        socket.add(Uint8List.fromList(bytes));
        await socket.flush();
      }
    } catch (_) {
      _failed = true;
      _pending.clear();
      onFailure?.call();
    } finally {
      _writing = false;
      for (final waiting in _waiting) {
        if (!waiting.isCompleted) waiting.complete();
      }
      _waiting.clear();
    }
  }

  /// Дождаться, пока всё накопленное уйдёт.
  Future<void> flush() async {
    while (!_failed && (_writing || _pending.length > 0)) {
      final waiting = Completer<void>();
      _waiting.add(waiting);
      await waiting.future;
    }
  }
}
