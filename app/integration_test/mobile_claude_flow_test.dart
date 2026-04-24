import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:gemini_remote_app/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  const baseUrl = String.fromEnvironment('TEST_BASE_URL');
  const pairPassword = String.fromEnvironment(
    'TEST_PAIR_PASSWORD',
    defaultValue: String.fromEnvironment('TEST_PAIR_CODE'),
  );
  const workspacePath = String.fromEnvironment('TEST_WORKSPACE_PATH');

  testWidgets(
    'pairs, adds a Claude workspace, starts a session, and sends a follow-up',
    (WidgetTester tester) async {
      if (baseUrl.isEmpty || pairPassword.isEmpty || workspacePath.isEmpty) {
        fail(
          'Expected TEST_BASE_URL, TEST_PAIR_PASSWORD (or legacy TEST_PAIR_CODE), and TEST_WORKSPACE_PATH dart-defines.',
        );
      }

      app.main();
      await _pumpUntilVisible(
        tester,
        find.byKey(const ValueKey('pair-host-field')),
      );

      await tester.enterText(
        find.byKey(const ValueKey('pair-host-field')),
        baseUrl,
      );
      await tester.enterText(
        find.byKey(const ValueKey('pair-password-field')),
        pairPassword,
      );
      await tester.tap(find.text('Pair and connect'));

      await _pumpUntilVisible(tester, find.text('Add workspace'));
      await tester.tap(find.text('Add workspace'));

      await _pumpUntilVisible(tester, find.text('Add workspace').last);
      await tester.enterText(find.byType(TextField).at(0), 'Claude E2E');
      await tester.tap(find.text('Claude').last);
      await tester.enterText(find.byType(TextField).at(1), workspacePath);
      await tester.tap(find.text('Create workspace'));

      await _pumpUntilVisible(tester, find.text('Claude E2E'));
      await _pumpUntilVisible(
        tester,
        find.byKey(const ValueKey('sessions-new-session-fab')).hitTestable(),
      );
      await tester.tap(
        find.byKey(const ValueKey('sessions-new-session-fab')).hitTestable(),
      );

      await _pumpUntilVisible(
        tester,
        find.text('Start a remote Claude Code session'),
      );
      await tester.enterText(
        find.byType(TextField).at(0),
        'Reply with the single word READY and nothing else.',
      );
      await tester.tap(
        find.byKey(const ValueKey('session-model-__default__')),
        warnIfMissed: false,
      );
      await _pumpShort(tester);
      await tester.tap(find.text('Sonnet (Latest)').last);
      await _pumpShort(tester);
      await tester.tap(find.text('Start session'));

      await _pumpUntilVisible(tester, find.text('READY'));

      await tester.enterText(
        find.byType(TextField).first,
        'Reply with the single word AGAIN and nothing else.',
      );
      await tester.testTextInput.receiveAction(TextInputAction.send);

      await _pumpUntilVisible(tester, find.text('AGAIN'));
    },
  );
}

Future<void> _pumpUntilVisible(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 45),
}) async {
  final end = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(end)) {
    await _pumpShort(tester);
    if (finder.evaluate().isNotEmpty) {
      return;
    }
  }

  fail('Timed out waiting for finder: $finder');
}

Future<void> _pumpShort(WidgetTester tester) {
  return tester.pump(const Duration(milliseconds: 250));
}
