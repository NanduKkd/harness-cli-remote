import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'models.dart';
import 'screens/pair_screen.dart';
import 'screens/session_detail_screen.dart';
import 'screens/workspaces_screen.dart';
import 'services/api_client.dart';
import 'services/session_monitor_bridge.dart';
import 'state/app_state.dart';
import 'theme.dart';

class GeminiRemoteApp extends ConsumerStatefulWidget {
  const GeminiRemoteApp({super.key});

  @override
  ConsumerState<GeminiRemoteApp> createState() => _GeminiRemoteAppState();
}

class _GeminiRemoteAppState extends ConsumerState<GeminiRemoteApp> {
  final GlobalKey<NavigatorState> _navigatorKey = GlobalKey<NavigatorState>();
  StreamSubscription<NotificationOpenTarget>? _notificationTargetSubscription;

  AuthSession? _configuredAuth;
  NotificationOpenTarget? _pendingNotificationTarget;
  bool _handlingNotificationTarget = false;
  int _monitorSyncRequestId = 0;

  @override
  void initState() {
    super.initState();
    final bridge = ref.read(sessionMonitorBridgeProvider);
    _notificationTargetSubscription = bridge.openedTargets.listen(
      _queueNotificationTarget,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_loadInitialNotificationTarget());
    });
  }

  @override
  void dispose() {
    _notificationTargetSubscription?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authControllerProvider);
    final auth = authState.valueOrNull;
    _configureForAuth(auth);

    return MaterialApp(
      title: 'Code Remotely',
      theme: buildAppTheme(),
      navigatorKey: _navigatorKey,
      debugShowCheckedModeBanner: false,
      home: authState.when(
        data: (resolvedAuth) => resolvedAuth == null
            ? const PairScreen()
            : const WorkspacesScreen(),
        loading: () => const _SplashScreen(),
        error: (error, _) => PairScreen(errorText: error.toString()),
      ),
    );
  }

  Future<void> _loadInitialNotificationTarget() async {
    final target = await ref
        .read(sessionMonitorBridgeProvider)
        .consumeInitialTarget();
    if (target == null) {
      return;
    }

    _queueNotificationTarget(target);
  }

  void _queueNotificationTarget(NotificationOpenTarget target) {
    _pendingNotificationTarget = target;
    unawaited(_processPendingNotificationTarget());
  }

  void _configureForAuth(AuthSession? auth) {
    if (_sameAuth(_configuredAuth, auth)) {
      return;
    }

    _configuredAuth = auth;
    final requestId = ++_monitorSyncRequestId;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) {
        return;
      }

      ref.read(realtimeServiceProvider).configure(auth);
      if (auth == null) {
        unawaited(ref.read(sessionMonitorBridgeProvider).stop());
        return;
      }

      unawaited(_syncSessionMonitor(auth, requestId: requestId));
      unawaited(_processPendingNotificationTarget());
    });
  }

  Future<void> _syncSessionMonitor(
    AuthSession auth, {
    required int requestId,
    Iterable<String> seedSessionIds = const <String>[],
  }) async {
    final runningSessionIds = <String>{
      for (final sessionId in seedSessionIds)
        if (sessionId.trim().isNotEmpty) sessionId.trim(),
    };
    final bridge = ref.read(sessionMonitorBridgeProvider);

    try {
      final api = ApiClient(auth);
      final workspaces = await api.listWorkspaces();
      final sessionLists = await Future.wait(
        workspaces.map((workspace) => api.listSessions(workspace.id)),
      );
      for (final sessions in sessionLists) {
        for (final session in sessions) {
          if (session.status == 'running') {
            runningSessionIds.add(session.id);
          }
        }
      }
    } catch (_) {
      if (runningSessionIds.isEmpty) {
        return;
      }
    }

    if (!mounted ||
        requestId != _monitorSyncRequestId ||
        !_sameAuth(_configuredAuth, auth)) {
      return;
    }

    if (runningSessionIds.isEmpty) {
      await bridge.stop();
    } else {
      await bridge.start(auth, sessionIds: runningSessionIds);
    }
  }

  Future<void> _processPendingNotificationTarget() async {
    if (_handlingNotificationTarget) {
      return;
    }

    final target = _pendingNotificationTarget;
    final auth = ref.read(authControllerProvider).valueOrNull;
    final navigator = _navigatorKey.currentState;
    if (target == null || auth == null || navigator == null) {
      return;
    }

    _handlingNotificationTarget = true;
    _pendingNotificationTarget = null;
    try {
      final api = ApiClient(auth);
      final workspaces = await api.listWorkspaces();
      final workspace = _findWorkspace(workspaces, target.workspaceId);
      if (workspace == null) {
        throw StateError('Workspace not found for this notification.');
      }

      final sessions = await api.listSessions(workspace.id);
      final session = _findSession(sessions, target.sessionId);
      if (session == null) {
        throw StateError('Session not found for this notification.');
      }

      if (!mounted) {
        return;
      }

      ref.invalidate(workspacesProvider);
      ref.invalidate(sessionsProvider(workspace.id));
      navigator.push(
        MaterialPageRoute<void>(
          builder: (_) =>
              SessionDetailScreen(workspace: workspace, session: session),
        ),
      );
    } catch (error) {
      if (mounted && navigator.mounted) {
        final messenger = ScaffoldMessenger.maybeOf(navigator.context);
        if (messenger != null) {
          messenger
            ..hideCurrentSnackBar()
            ..showSnackBar(SnackBar(content: Text(error.toString())));
        }
      }
    } finally {
      _handlingNotificationTarget = false;
      if (_pendingNotificationTarget != null) {
        unawaited(_processPendingNotificationTarget());
      }
    }
  }
}

class _SplashScreen extends StatelessWidget {
  const _SplashScreen();

  @override
  Widget build(BuildContext context) {
    return const AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.dark,
      child: Scaffold(body: Center(child: CircularProgressIndicator())),
    );
  }
}

Workspace? _findWorkspace(List<Workspace> workspaces, String workspaceId) {
  for (final workspace in workspaces) {
    if (workspace.id == workspaceId) {
      return workspace;
    }
  }
  return null;
}

RemoteSession? _findSession(List<RemoteSession> sessions, String sessionId) {
  for (final session in sessions) {
    if (session.id == sessionId) {
      return session;
    }
  }
  return null;
}

bool _sameAuth(AuthSession? left, AuthSession? right) {
  return left?.baseUrl == right?.baseUrl && left?.token == right?.token;
}
