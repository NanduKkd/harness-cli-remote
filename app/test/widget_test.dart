import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:gemini_remote_app/src/models.dart';
import 'package:gemini_remote_app/src/screens/pair_screen.dart';
import 'package:gemini_remote_app/src/screens/session_detail_screen.dart';
import 'package:gemini_remote_app/src/services/api_client.dart';
import 'package:gemini_remote_app/src/services/auth_storage.dart';
import 'package:gemini_remote_app/src/services/realtime_service.dart';
import 'package:gemini_remote_app/src/state/app_state.dart';

class FakeAuthStorage extends AuthStorage {
  FakeAuthStorage({List<String>? recentHosts})
    : _recentHosts = List<String>.from(recentHosts ?? const []);

  final List<String> _recentHosts;
  AuthSession? lastWrittenSession;

  @override
  Future<List<String>> readRecentHosts() async =>
      List<String>.from(_recentHosts);

  @override
  Future<void> write(AuthSession session) async {
    lastWrittenSession = session;
    _recentHosts.remove(session.baseUrl);
    _recentHosts.insert(0, session.baseUrl);
  }
}

class FakeHttpClient extends http.BaseClient {
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final requestPath = request.url.path;
    if (request.method == 'GET' &&
        (requestPath == '/health' || requestPath.endsWith('/health'))) {
      return http.StreamedResponse(
        Stream<List<int>>.value(utf8.encode('{"ok":true}')),
        200,
        headers: const {'content-type': 'application/json'},
        request: request,
      );
    }

    return http.StreamedResponse(
      Stream<List<int>>.empty(),
      404,
      request: request,
    );
  }

  @override
  void close() {}
}

class FakeSessionApiClient extends ApiClient {
  FakeSessionApiClient({required this.sessions, required this.events})
    : super(const AuthSession(baseUrl: 'http://127.0.0.1:8918', token: 't'));

  final List<RemoteSession> sessions;
  final List<SessionEvent> events;

  @override
  Future<List<RemoteSession>> listSessions(String workspaceId) async =>
      sessions;

  @override
  Future<List<SessionEvent>> getEvents({
    required String sessionId,
    int afterSeq = 0,
    int? beforeSeq,
    int? limit,
  }) async {
    var filtered = events.where((event) => event.sessionId == sessionId);
    if (beforeSeq != null) {
      filtered = filtered.where((event) => event.seq < beforeSeq);
    } else {
      filtered = filtered.where((event) => event.seq > afterSeq);
    }

    final ordered = filtered.toList()..sort((left, right) => left.seq.compareTo(right.seq));
    if (beforeSeq != null && limit != null && ordered.length > limit) {
      return ordered.sublist(ordered.length - limit);
    }
    if (beforeSeq == null && afterSeq == 0 && limit != null && ordered.length > limit) {
      return ordered.sublist(ordered.length - limit);
    }
    return ordered;
  }
}

class FakeAuthController extends AuthController {
  FakeAuthController(this.storage) : super(storage) {
    state = const AsyncValue.data(null);
  }

  final AuthStorage storage;
  String? lastBaseUrl;
  String? lastPassword;

  @override
  Future<void> load() async {}

  @override
  Future<void> pair({required String baseUrl, required String password}) async {
    lastBaseUrl = baseUrl;
    lastPassword = password;
    final auth = AuthSession(baseUrl: baseUrl, token: 'token');
    await storage.write(auth);
    state = AsyncValue.data(auth);
  }
}

void main() {
  testWidgets('supports recent hosts, clear/paste, and pairing validation', (
    WidgetTester tester,
  ) async {
    final host = 'http://127.0.0.1:8918';
    final storage = FakeAuthStorage(recentHosts: [host]);
    final controller = FakeAuthController(storage);
    final httpClient = FakeHttpClient();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authStorageProvider.overrideWithValue(storage),
          authControllerProvider.overrideWith((ref) => controller),
          httpClientProvider.overrideWithValue(httpClient),
        ],
        child: const MaterialApp(home: PairScreen()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Recent hosts'), findsOneWidget);

    final hostField = find.byKey(const ValueKey('pair-host-field'));
    final passwordField = find.byKey(const ValueKey('pair-password-field'));

    EditableText hostEditable = tester.widget<EditableText>(
      find.descendant(of: hostField, matching: find.byType(EditableText)),
    );
    expect(hostEditable.controller.text, host);

    await tester.tap(find.byTooltip('Clear host URL'));
    await tester.pump();
    hostEditable = tester.widget<EditableText>(
      find.descendant(of: hostField, matching: find.byType(EditableText)),
    );
    expect(hostEditable.controller.text, isEmpty);

    await tester.tap(find.widgetWithText(InputChip, host));
    await tester.pump();
    hostEditable = tester.widget<EditableText>(
      find.descendant(of: hostField, matching: find.byType(EditableText)),
    );
    expect(hostEditable.controller.text, host);

    await tester.enterText(passwordField, 'my-secret-password');
    await tester.tap(find.text('Pair and connect'));
    await tester.pumpAndSettle();

    expect(controller.lastBaseUrl, host);
    expect(controller.lastPassword, 'my-secret-password');
    expect(storage.lastWrittenSession?.baseUrl, host);
    expect(find.textContaining('Pairing succeeded'), findsOneWidget);
  });

  testWidgets('preserves path-prefixed hosts during pairing', (
    WidgetTester tester,
  ) async {
    final storage = FakeAuthStorage();
    final controller = FakeAuthController(storage);
    final httpClient = FakeHttpClient();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authStorageProvider.overrideWithValue(storage),
          authControllerProvider.overrideWith((ref) => controller),
          httpClientProvider.overrideWithValue(httpClient),
        ],
        child: const MaterialApp(home: PairScreen()),
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(
      find.byKey(const ValueKey('pair-host-field')),
      'http://127.0.0.1:8918/ieb8izzxc0bt/',
    );
    await tester.enterText(
      find.byKey(const ValueKey('pair-password-field')),
      'my-secret-password',
    );
    await tester.tap(find.text('Pair and connect'));
    await tester.pumpAndSettle();

    expect(controller.lastBaseUrl, 'http://127.0.0.1:8918/ieb8izzxc0bt');
    expect(
      storage.lastWrittenSession?.baseUrl,
      'http://127.0.0.1:8918/ieb8izzxc0bt',
    );
    expect(find.textContaining('Pairing succeeded'), findsOneWidget);
  });

  testWidgets('long pressing an AI message copies it to the clipboard', (
    WidgetTester tester,
  ) async {
    const copiedMessage = 'Copy this AI reply';
    final now = DateTime(2026, 4, 10, 12, 0);
    const workspace = Workspace(
      id: 'workspace-1',
      name: 'Workspace',
      rootPath: '/tmp/workspace',
      provider: 'gemini',
      hookStatus: 'installed',
    );
    final session = RemoteSession(
      id: 'session-1',
      workspaceId: workspace.id,
      model: 'gemini-2.5-pro',
      providerSessionId: 'provider-session-1',
      geminiSessionId: 'provider-session-1',
      transcriptPath: '/tmp/transcript.jsonl',
      status: 'completed',
      lastMessageStatus: 'completed',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      lastRunId: 'run-1',
    );
    final apiClient = FakeSessionApiClient(
      sessions: [session],
      events: [
        SessionEvent(
          sessionId: session.id,
          runId: 'run-1',
          seq: 1,
          type: 'message.completed',
          ts: now,
          payload: const {'text': copiedMessage},
        ),
      ],
    );
    final realtimeService = RealtimeService();
    final clipboardCalls = <MethodCall>[];
    String? clipboardText;

    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        clipboardCalls.add(call);
        if (call.method == 'Clipboard.setData') {
          clipboardText =
              (call.arguments as Map<Object?, Object?>)['text'] as String?;
          return null;
        }
        if (call.method == 'Clipboard.getData') {
          return <String, dynamic>{'text': clipboardText};
        }
        return null;
      },
    );
    addTearDown(() {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      );
      realtimeService.dispose();
    });

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(apiClient),
          realtimeServiceProvider.overrideWithValue(realtimeService),
        ],
        child: MaterialApp(
          home: SessionDetailScreen(workspace: workspace, session: session),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text(copiedMessage), findsOneWidget);

    await tester.longPress(find.text(copiedMessage));
    await tester.pump();

    expect(clipboardText, copiedMessage);
    expect(
      clipboardCalls.where((call) => call.method == 'Clipboard.setData'),
      isNotEmpty,
    );
    expect(find.text('Copied AI message to clipboard.'), findsOneWidget);
  });
}
