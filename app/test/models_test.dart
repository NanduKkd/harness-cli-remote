import 'package:flutter_test/flutter_test.dart';

import 'package:gemini_remote_app/src/models.dart';

void main() {
  test('Claude provider helpers expose the expected labels and presets', () {
    expect(providerDisplayName('claude'), 'Claude Code');
    expect(providerSessionLabel('claude'), 'Session id');

    final options = providerModelOptions('claude');
    expect(
      options.any((option) => option.value == 'claude-sonnet-4-6'),
      isTrue,
    );
    expect(
      options.any((option) => option.value == 'claude-opus-4-6'),
      isTrue,
    );
    expect(options.any((option) => option.value == 'sonnet'), isTrue);
    expect(isKnownProviderModel('claude', 'claude-sonnet-4-6'), isTrue);
  });

  test('Codex provider helpers expose GPT-5.5', () {
    final options = providerModelOptions('codex');

    expect(options.any((option) => option.value == 'gpt-5.5'), isTrue);
    expect(isKnownProviderModel('codex', 'gpt-5.5'), isTrue);
  });
}
