import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:gemini_remote_app/src/models.dart';
import 'package:gemini_remote_app/src/screens/session_detail_screen.dart';
import 'package:gemini_remote_app/src/services/api_client.dart';
import 'package:gemini_remote_app/src/services/realtime_service.dart';
import 'package:gemini_remote_app/src/state/app_state.dart';

class FakeApiClient extends ApiClient {
  FakeApiClient({required this.events, required this.sessions})
    : super(const AuthSession(baseUrl: 'http://example.test', token: 'token'));

  final List<SessionEvent> events;
  final List<RemoteSession> sessions;

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

  @override
  Future<List<RemoteSession>> listSessions(String workspaceId) async {
    return sessions
        .where((session) => session.workspaceId == workspaceId)
        .toList();
  }
}

class FakeRealtimeService extends RealtimeService {
  final StreamController<RealtimeEnvelope> _messageController =
      StreamController<RealtimeEnvelope>.broadcast();
  final StreamController<ConnectionStatus> _statusController =
      StreamController<ConnectionStatus>.broadcast();

  final ConnectionStatus _currentStatus = ConnectionStatus.connected;

  @override
  Stream<RealtimeEnvelope> get messages => _messageController.stream;

  @override
  Stream<ConnectionStatus> get statuses => _statusController.stream;

  @override
  ConnectionStatus get status => _currentStatus;

  void emit({required String workspaceId, required SessionEvent event}) {
    _messageController.add(
      RealtimeEnvelope(
        sessionId: event.sessionId,
        workspaceId: workspaceId,
        event: event,
      ),
    );
  }

  @override
  void dispose() {
    _messageController.close();
    _statusController.close();
  }
}

void main() {
  final workspace = Workspace(
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
    geminiSessionId: 'gemini-session-1',
    transcriptPath: '/tmp/workspace/transcript.jsonl',
    status: 'running',
    lastMessageStatus: 'completed',
    createdAt: DateTime(2026, 4, 10, 9),
    updatedAt: DateTime(2026, 4, 10, 9, 30),
    lastActivityAt: DateTime(2026, 4, 10, 9, 30),
    lastRunId: 'run-16',
  );

  List<SessionEvent> seedConversation() {
    final events = <SessionEvent>[];
    var seq = 1;
    for (var index = 0; index < 18; index += 1) {
      final runId = 'run-${index + 1}';
      events.add(
        SessionEvent(
          sessionId: session.id,
          runId: runId,
          seq: seq++,
          type: 'run.started',
          ts: DateTime(2026, 4, 10, 9, index),
          payload: {'prompt': 'Prompt ${index + 1}'},
        ),
      );
      events.add(
        SessionEvent(
          sessionId: session.id,
          runId: runId,
          seq: seq++,
          type: 'message.completed',
          ts: DateTime(2026, 4, 10, 9, index, 30),
          payload: {
            'text': List<String>.filled(
              10,
              'Reply ${index + 1} line that makes the conversation tall.',
            ).join('\n'),
          },
        ),
      );
      events.add(
        SessionEvent(
          sessionId: session.id,
          runId: runId,
          seq: seq++,
          type: 'run.completed',
          ts: DateTime(2026, 4, 10, 9, index, 45),
          payload: const {},
        ),
      );
    }
    return events;
  }

  Finder conversationList() {
    return find.byKey(const ValueKey('session-conversation-list'));
  }

  ScrollPosition conversationPosition(WidgetTester tester) {
    final listView = tester.widget<ListView>(conversationList());
    final controller = listView.controller;
    expect(controller, isNotNull);
    expect(controller!.hasClients, isTrue);
    return controller.position;
  }

  Future<void> pumpConversation(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 150));
    await tester.pumpAndSettle();
  }

  void expectAtBottom(WidgetTester tester) {
    final position = conversationPosition(tester);
    expect(position.maxScrollExtent, greaterThan(0));
    expect(position.pixels, closeTo(position.maxScrollExtent, 1));
  }

  testWidgets('opens at the end and refresh returns to the end', (
    WidgetTester tester,
  ) async {
    final events = seedConversation();
    final apiClient = FakeApiClient(events: events, sessions: [session]);
    final realtime = FakeRealtimeService();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(apiClient),
          realtimeServiceProvider.overrideWithValue(realtime),
        ],
        child: MaterialApp(
          home: SessionDetailScreen(workspace: workspace, session: session),
        ),
      ),
    );
    await pumpConversation(tester);

    expectAtBottom(tester);

    await tester.drag(conversationList(), const Offset(0, 500));
    await tester.pumpAndSettle();

    final positionBeforeRefresh = conversationPosition(tester);
    expect(
      positionBeforeRefresh.pixels,
      lessThan(positionBeforeRefresh.maxScrollExtent - 50),
    );

    final nextSeq = events.last.seq + 1;
    events.add(
      SessionEvent(
        sessionId: session.id,
        runId: null,
        seq: nextSeq,
        type: 'notification',
        ts: DateTime(2026, 4, 10, 10),
        payload: {
          'message': List<String>.filled(
            10,
            'Fresh activity after a manual refresh.',
          ).join('\n'),
        },
      ),
    );

    await tester.tap(find.byTooltip('Conversation actions'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Refresh'));
    await pumpConversation(tester);

    expectAtBottom(tester);
  });

  testWidgets('stays pinned when a live response grows at the bottom', (
    WidgetTester tester,
  ) async {
    final events = seedConversation();
    final apiClient = FakeApiClient(events: events, sessions: [session]);
    final realtime = FakeRealtimeService();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(apiClient),
          realtimeServiceProvider.overrideWithValue(realtime),
        ],
        child: MaterialApp(
          home: SessionDetailScreen(workspace: workspace, session: session),
        ),
      ),
    );
    await pumpConversation(tester);

    expectAtBottom(tester);

    final runStarted = SessionEvent(
      sessionId: session.id,
      runId: 'run-live',
      seq: events.last.seq + 1,
      type: 'run.started',
      ts: DateTime(2026, 4, 10, 10, 1),
      payload: {'prompt': 'Tell me more'},
    );
    realtime.emit(workspaceId: workspace.id, event: runStarted);
    await pumpConversation(tester);

    final firstDelta = SessionEvent(
      sessionId: session.id,
      runId: 'run-live',
      seq: runStarted.seq + 1,
      type: 'message.delta',
      ts: DateTime(2026, 4, 10, 10, 1, 5),
      payload: {'fullText': 'Short live reply.\n' * 6},
    );
    realtime.emit(workspaceId: workspace.id, event: firstDelta);
    await pumpConversation(tester);

    final firstExtent = conversationPosition(tester).maxScrollExtent;
    expectAtBottom(tester);

    final secondDelta = SessionEvent(
      sessionId: session.id,
      runId: 'run-live',
      seq: firstDelta.seq + 1,
      type: 'message.delta',
      ts: DateTime(2026, 4, 10, 10, 1, 10),
      payload: {
        'fullText': 'Long live reply that should keep the view pinned.\n' * 60,
      },
    );
    realtime.emit(workspaceId: workspace.id, event: secondDelta);
    await pumpConversation(tester);

    expect(
      conversationPosition(tester).maxScrollExtent,
      greaterThan(firstExtent),
    );
    expectAtBottom(tester);
  });

  testWidgets('legacy file_change notifications render as tool cards', (
    WidgetTester tester,
  ) async {
    final events = <SessionEvent>[
      SessionEvent(
        sessionId: session.id,
        runId: 'run-file-change',
        seq: 1,
        type: 'notification',
        ts: DateTime(2026, 4, 10, 10),
        payload: {
          'notificationType': 'file_change',
          'message': 'Codex reported File Change activity.',
          'details': '''
{
  "id": "item_28",
  "type": "file_change",
  "changes": [
    {
      "path": "/tmp/workspace/app/lib/src/example.dart",
      "kind": "update"
    }
  ],
  "status": "completed"
}
''',
        },
      ),
    ];
    final apiClient = FakeApiClient(events: events, sessions: [session]);
    final realtime = FakeRealtimeService();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(apiClient),
          realtimeServiceProvider.overrideWithValue(realtime),
        ],
        child: MaterialApp(
          home: SessionDetailScreen(workspace: workspace, session: session),
        ),
      ),
    );
    await pumpConversation(tester);

    expect(find.text('File Change'), findsOneWidget);
    expect(find.text('Notification'), findsNothing);
    await tester.tap(find.text('Show Details'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Changes:'), findsOneWidget);
    expect(find.textContaining('Status: completed'), findsOneWidget);
  });
}
