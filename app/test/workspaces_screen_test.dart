import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:gemini_remote_app/src/models.dart';
import 'package:gemini_remote_app/src/theme.dart';
import 'package:gemini_remote_app/src/screens/workspaces_screen.dart';
import 'package:gemini_remote_app/src/services/api_client.dart';
import 'package:gemini_remote_app/src/state/app_state.dart';

class FakeWorkspaceApiClient extends ApiClient {
  FakeWorkspaceApiClient({
    required this.workspaces,
    required this.sessionsByWorkspace,
  }) : super(const AuthSession(baseUrl: 'http://example.test', token: 'token'));

  final List<Workspace> workspaces;
  final Map<String, List<RemoteSession>> sessionsByWorkspace;
  String? createdProvider;

  @override
  Future<List<Workspace>> listWorkspaces() async => workspaces;

  @override
  Future<List<RemoteSession>> listSessions(String workspaceId) async {
    return sessionsByWorkspace[workspaceId] ?? const [];
  }

  @override
  Future<Workspace> createWorkspace({
    String? name,
    required String rootPath,
    required String provider,
  }) async {
    createdProvider = provider;
    return Workspace(
      id: 'workspace-created',
      name: name?.trim().isNotEmpty == true ? name!.trim() : 'Created',
      rootPath: rootPath,
      provider: provider,
      hookStatus: 'installed',
    );
  }

  @override
  Future<DirectoryListing> browseDirectories({String? path}) async {
    return DirectoryListing(
      currentPath: path ?? '/tmp',
      parentPath: null,
      directories: const [],
    );
  }
}

void main() {
  testWidgets(
    'shows active session count only when positive and sorts by latest activity',
    (WidgetTester tester) async {
      final now = DateTime(2026, 4, 15, 9, 0);
      final workspaceRecent = Workspace(
        id: 'workspace-recent',
        name: 'Recent Workspace',
        rootPath: '/tmp/recent',
        provider: 'gemini',
        hookStatus: 'installed',
      );
      final workspaceActive = Workspace(
        id: 'workspace-active',
        name: 'Active Workspace',
        rootPath: '/tmp/active',
        provider: 'gemini',
        hookStatus: 'installed',
      );
      final workspaceIdle = Workspace(
        id: 'workspace-idle',
        name: 'Idle Workspace',
        rootPath: '/tmp/idle',
        provider: 'gemini',
        hookStatus: 'installed',
      );

      RemoteSession session({
        required String id,
        required String workspaceId,
        required String status,
        required String lastMessageStatus,
        required DateTime lastActivityAt,
      }) {
        return RemoteSession(
          id: id,
          workspaceId: workspaceId,
          model: null,
          providerSessionId: null,
          geminiSessionId: null,
          transcriptPath: null,
          status: status,
          lastMessageStatus: lastMessageStatus,
          createdAt: now.subtract(const Duration(hours: 2)),
          updatedAt: lastActivityAt,
          lastActivityAt: lastActivityAt,
          lastRunId: null,
        );
      }

      final apiClient = FakeWorkspaceApiClient(
        workspaces: [workspaceIdle, workspaceActive, workspaceRecent],
        sessionsByWorkspace: {
          workspaceRecent.id: [
            session(
              id: 'recent-1',
              workspaceId: workspaceRecent.id,
              status: 'idle',
              lastMessageStatus: 'completed',
              lastActivityAt: now.subtract(const Duration(minutes: 3)),
            ),
          ],
          workspaceActive.id: [
            session(
              id: 'active-1',
              workspaceId: workspaceActive.id,
              status: 'running',
              lastMessageStatus: 'running',
              lastActivityAt: now.subtract(const Duration(hours: 1)),
            ),
            session(
              id: 'active-2',
              workspaceId: workspaceActive.id,
              status: 'running',
              lastMessageStatus: 'running',
              lastActivityAt: now.subtract(const Duration(hours: 2)),
            ),
          ],
          workspaceIdle.id: const [],
        },
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [apiClientProvider.overrideWithValue(apiClient)],
          child: const MaterialApp(home: WorkspacesScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('2 active'), findsOneWidget);
      expect(find.text('1 active'), findsNothing);
      expect(find.text('0 active'), findsNothing);

      final recentY = tester.getTopLeft(find.text('Recent Workspace')).dy;
      final activeY = tester.getTopLeft(find.text('Active Workspace')).dy;
      final idleY = tester.getTopLeft(find.text('Idle Workspace')).dy;

      expect(recentY, lessThan(activeY));
      expect(activeY, lessThan(idleY));
    },
  );

  testWidgets('supports Claude in filters and workspace creation', (
    WidgetTester tester,
  ) async {
    final apiClient = FakeWorkspaceApiClient(
      workspaces: const [
        Workspace(
          id: 'workspace-claude',
          name: 'Claude Workspace',
          rootPath: '/tmp/claude',
          provider: 'claude',
          hookStatus: 'installed',
        ),
      ],
      sessionsByWorkspace: const {},
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiClientProvider.overrideWithValue(apiClient)],
        child: MaterialApp(
          theme: buildAppTheme(),
          home: const WorkspacesScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Claude'), findsOneWidget);
    expect(find.text('Claude Code'), findsOneWidget);

    await tester.tap(find.text('Add workspace'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Claude').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).at(1), '/tmp/claude-project');
    await tester.tap(find.text('Create workspace'));
    await tester.pumpAndSettle();

    expect(apiClient.createdProvider, 'claude');
  });
}
