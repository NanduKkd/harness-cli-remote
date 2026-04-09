import 'dart:async';

import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../models.dart';

class RunNotificationService {
  static const String _channelId = 'remote_run_status';
  static const String _channelName = 'Run status';
  static const String _channelDescription =
      'Notifications for remote run completion and failure.';
  static const String _genericSuccessBody =
      'The remote run finished successfully.';

  final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();
  final Set<String> _notifiedKeys = <String>{};
  final List<String> _notificationOrder = <String>[];

  Future<void>? _initialization;
  bool _permissionRequested = false;

  Future<void> ensureInitialized() {
    final existing = _initialization;
    if (existing != null) {
      return existing;
    }

    final future = _initialize();
    _initialization = future.then(
      (_) {},
      onError: (Object error, StackTrace stackTrace) {
        _initialization = null;
        Error.throwWithStackTrace(error, stackTrace);
      },
    );
    return _initialization!;
  }

  Future<void> handleEnvelope(RealtimeEnvelope envelope) async {
    final event = envelope.event;
    if (event.type != 'run.completed' && event.type != 'run.failed') {
      return;
    }

    final key = _notificationKey(envelope);
    if (!_notifiedKeys.add(key)) {
      return;
    }

    _notificationOrder.add(key);
    _trimCache();

    try {
      await ensureInitialized();
      final content = _contentFor(envelope);
      await _plugin.show(
        key.hashCode & 0x7fffffff,
        content.title,
        content.body,
        _notificationDetails,
      );
    } catch (_) {
      _removeNotificationKey(key);
    }
  }

  Future<void> _initialize() async {
    const androidSettings = AndroidInitializationSettings('ic_stat_remote');
    const initializationSettings = InitializationSettings(
      android: androidSettings,
    );

    await _plugin.initialize(initializationSettings);
    await _requestAndroidPermission();
  }

  Future<void> _requestAndroidPermission() async {
    if (_permissionRequested) {
      return;
    }
    _permissionRequested = true;

    final android = _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >();
    if (android != null) {
      await android.requestNotificationsPermission();
    }
  }

  NotificationDetails get _notificationDetails {
    return const NotificationDetails(
      android: AndroidNotificationDetails(
        _channelId,
        _channelName,
        channelDescription: _channelDescription,
        importance: Importance.high,
        priority: Priority.high,
        playSound: true,
        enableVibration: true,
      ),
    );
  }

  _NotificationContent _contentFor(RealtimeEnvelope envelope) {
    final event = envelope.event;
    final isSuccess = event.type == 'run.completed';
    final title = isSuccess ? 'Run completed' : 'Run failed';
    final summary = _trimmedText(
      isSuccess ? event.payload['stdoutTail'] : event.payload['stderrTail'],
    );

    if (summary != null && summary.isNotEmpty) {
      return _NotificationContent(title: title, body: summary);
    }

    if (isSuccess) {
      return const _NotificationContent(
        title: 'Run completed',
        body: _genericSuccessBody,
      );
    }

    final exitCode = event.payload['exitCode'];
    final signal = event.payload['signal'];
    final failureParts = <String>['The remote run failed.'];
    if (exitCode != null) {
      failureParts.add('Exit code ${exitCode.toString()}.');
    } else if (signal != null) {
      failureParts.add('Signal ${signal.toString()}.');
    }

    return _NotificationContent(title: title, body: failureParts.join(' '));
  }

  String _notificationKey(RealtimeEnvelope envelope) {
    final runId = envelope.event.runId ?? 'no-run-${envelope.event.seq}';
    return '${envelope.sessionId}:$runId:${envelope.event.type}';
  }

  void _trimCache() {
    const maxCachedKeys = 256;
    while (_notificationOrder.length > maxCachedKeys) {
      final oldestKey = _notificationOrder.removeAt(0);
      _notifiedKeys.remove(oldestKey);
    }
  }

  void _removeNotificationKey(String key) {
    _notifiedKeys.remove(key);
    _notificationOrder.remove(key);
  }

  String? _trimmedText(Object? value) {
    if (value == null) {
      return null;
    }

    final raw = value.toString().trim();
    if (raw.isEmpty || raw == 'null') {
      return null;
    }

    final firstLine = raw.split(RegExp(r'[\r\n]+')).first.trim();
    if (firstLine.isEmpty) {
      return null;
    }

    return firstLine.length > 160
        ? '${firstLine.substring(0, 157)}...'
        : firstLine;
  }
}

class _NotificationContent {
  const _NotificationContent({required this.title, required this.body});

  final String title;
  final String body;
}
