import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:gemini_remote_app/src/services/auth_storage.dart';
import 'package:gemini_remote_app/src/app.dart';
import 'package:gemini_remote_app/src/state/app_state.dart';

class FakeAuthController extends AuthController {
  FakeAuthController() : super(const AuthStorage()) {
    state = const AsyncValue.data(null);
  }

  @override
  Future<void> load() async {}
}

void main() {
  testWidgets('shows pair screen when there is no saved auth session', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authControllerProvider.overrideWith((ref) => FakeAuthController()),
        ],
        child: const GeminiRemoteApp(),
      ),
    );
    await tester.pump();

    expect(find.text('Pair Host'), findsOneWidget);
    expect(find.text('Pair and connect'), findsOneWidget);
  });
}
