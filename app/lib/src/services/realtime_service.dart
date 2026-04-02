import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:web_socket_channel/io.dart';

import '../models.dart';

class RealtimeService {
  final StreamController<RealtimeEnvelope> _messages =
      StreamController<RealtimeEnvelope>.broadcast();
  final StreamController<ConnectionStatus> _statuses =
      StreamController<ConnectionStatus>.broadcast();

  IOWebSocketChannel? _channel;
  Timer? _retryTimer;
  AuthSession? _auth;
  ConnectionStatus _status = ConnectionStatus.disconnected;
  int _retryAttempt = 0;
  bool _disposed = false;

  Stream<RealtimeEnvelope> get messages => _messages.stream;
  Stream<ConnectionStatus> get statuses => _statuses.stream;
  ConnectionStatus get status => _status;

  void configure(AuthSession? auth) {
    if (_sameAuth(_auth, auth)) {
      return;
    }

    _auth = auth;
    _retryAttempt = 0;
    _retryTimer?.cancel();
    _closeChannel();

    if (auth == null) {
      _setStatus(ConnectionStatus.disconnected);
      return;
    }

    _connect();
  }

  void dispose() {
    _disposed = true;
    _retryTimer?.cancel();
    _closeChannel();
    _messages.close();
    _statuses.close();
  }

  void _connect() {
    final auth = _auth;
    if (_disposed || auth == null) {
      return;
    }

    _setStatus(ConnectionStatus.connecting);
    final channel = IOWebSocketChannel.connect(auth.websocketUri);
    _channel = channel;
    _setStatus(ConnectionStatus.connected);

    channel.stream.listen(
      (dynamic data) {
        final parsed = jsonDecode(data as String);
        if (parsed is! Map<String, dynamic>) {
          return;
        }
        if (parsed['type'] == 'session.event') {
          _messages.add(RealtimeEnvelope.fromJson(parsed));
        }
      },
      onDone: _handleDisconnect,
      onError: (_) => _handleDisconnect(),
      cancelOnError: true,
    );
  }

  void _handleDisconnect() {
    _closeChannel();
    if (_auth == null || _disposed) {
      _setStatus(ConnectionStatus.disconnected);
      return;
    }

    _setStatus(ConnectionStatus.disconnected);
    _retryTimer?.cancel();
    final delaySeconds = min(30, pow(2, _retryAttempt).toInt());
    _retryAttempt += 1;
    _retryTimer = Timer(Duration(seconds: delaySeconds), () {
      _retryTimer = null;
      _connect();
    });
  }

  void _closeChannel() {
    _channel?.sink.close();
    _channel = null;
  }

  void _setStatus(ConnectionStatus value) {
    _status = value;
    _statuses.add(value);
  }

  bool _sameAuth(AuthSession? left, AuthSession? right) {
    return left?.baseUrl == right?.baseUrl && left?.token == right?.token;
  }
}
