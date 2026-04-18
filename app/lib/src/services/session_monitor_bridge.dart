import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';

import '../models.dart';

class NotificationOpenTarget {
  const NotificationOpenTarget({
    required this.workspaceId,
    required this.sessionId,
  });

  factory NotificationOpenTarget.fromMap(Map<Object?, Object?> raw) {
    return NotificationOpenTarget(
      workspaceId: raw['workspaceId'] as String,
      sessionId: raw['sessionId'] as String,
    );
  }

  final String workspaceId;
  final String sessionId;
}

class SessionMonitorBridge {
  const SessionMonitorBridge();

  static const MethodChannel _methodChannel = MethodChannel(
    'gemini_remote/session_monitor',
  );
  static const EventChannel _eventChannel = EventChannel(
    'gemini_remote/notification_opens',
  );

  Stream<NotificationOpenTarget> get openedTargets {
    if (!_isAndroid) {
      return const Stream<NotificationOpenTarget>.empty();
    }

    return _eventChannel
        .receiveBroadcastStream()
        .map((dynamic raw) {
          if (raw is! Map<Object?, Object?>) {
            throw const FormatException('Invalid notification payload.');
          }
          return NotificationOpenTarget.fromMap(raw);
        })
        .handleError((Object _) {});
  }

  Future<void> start(
    AuthSession auth, {
    required Iterable<String> sessionIds,
  }) async {
    if (!_isAndroid) {
      return;
    }

    final normalizedIds = sessionIds
        .map((id) => id.trim())
        .where((id) => id.isNotEmpty)
        .toSet()
        .toList();
    if (normalizedIds.isEmpty) {
      return stop();
    }

    try {
      await _methodChannel.invokeMethod<bool>('startSessionMonitor', {
        'baseUrl': auth.baseUrl,
        'token': auth.token,
        'sessionIds': normalizedIds,
      });
    } on MissingPluginException {
      return;
    } on PlatformException {
      return;
    }
  }

  Future<void> stop() async {
    if (!_isAndroid) {
      return;
    }

    try {
      await _methodChannel.invokeMethod<bool>('stopSessionMonitor');
    } on MissingPluginException {
      return;
    } on PlatformException {
      return;
    }
  }

  Future<NotificationOpenTarget?> consumeInitialTarget() async {
    if (!_isAndroid) {
      return null;
    }

    try {
      final raw = await _methodChannel.invokeMapMethod<Object?, Object?>(
        'consumeInitialNotificationTarget',
      );
      if (raw == null) {
        return null;
      }
      return NotificationOpenTarget.fromMap(raw);
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
  }

  bool get _isAndroid => Platform.isAndroid;
}
