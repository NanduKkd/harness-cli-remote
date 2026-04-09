import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:gemini_remote_app/src/models.dart';
import 'package:gemini_remote_app/src/screens/pair_screen.dart';
import 'package:gemini_remote_app/src/services/auth_storage.dart';
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
    if (request.method == 'GET' && request.url.path == '/health') {
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

class FakeAuthController extends AuthController {
  FakeAuthController(this.storage) : super(storage) {
    state = const AsyncValue.data(null);
  }

  final AuthStorage storage;
  String? lastBaseUrl;
  String? lastCode;

  @override
  Future<void> load() async {}

  @override
  Future<void> pair({required String baseUrl, required String code}) async {
    lastBaseUrl = baseUrl;
    lastCode = code;
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
    final codeField = find.byKey(const ValueKey('pair-code-field'));

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

    await tester.enterText(codeField, '123-456');
    await tester.tap(find.text('Pair and connect'));
    await tester.pumpAndSettle();

    expect(controller.lastBaseUrl, host);
    expect(controller.lastCode, '123-456');
    expect(storage.lastWrittenSession?.baseUrl, host);
    expect(find.textContaining('Pairing succeeded'), findsOneWidget);
  });
}
