import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/app_state.dart';
import '../widgets/chrome.dart';

class PairScreen extends ConsumerStatefulWidget {
  const PairScreen({
    super.key,
    this.errorText,
  });

  final String? errorText;

  @override
  ConsumerState<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends ConsumerState<PairScreen> {
  late final TextEditingController _hostController;
  late final TextEditingController _codeController;

  @override
  void initState() {
    super.initState();
    _hostController = TextEditingController(text: 'http://192.168.1.10:8918');
    _codeController = TextEditingController();
  }

  @override
  void dispose() {
    _hostController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authControllerProvider);
    final isBusy = authState.isLoading;

    ref.listen<AsyncValue<Object?>>(authControllerProvider, (previous, next) {
      next.whenOrNull(
        error: (error, _) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(error.toString())),
          );
        },
      );
    });

    return AtmosphereScaffold(
      title: 'Pair Host',
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const SectionCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              spacing: 12,
              children: [
                Text(
                  'Connect your phone to the Gemini Remote host daemon running on your computer.',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
                ),
                Text(
                  'Use the host machine URL and the pairing code printed by the daemon at startup.',
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          SectionCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              spacing: 14,
              children: [
                TextField(
                  controller: _hostController,
                  keyboardType: TextInputType.url,
                  decoration: const InputDecoration(
                    labelText: 'Host URL',
                    hintText: 'http://192.168.1.10:8918',
                  ),
                ),
                TextField(
                  controller: _codeController,
                  decoration: const InputDecoration(
                    labelText: 'Pairing code',
                    hintText: '123-456',
                  ),
                ),
                FilledButton.icon(
                  onPressed: isBusy
                      ? null
                      : () {
                          ref
                              .read(authControllerProvider.notifier)
                              .pair(
                                baseUrl: _hostController.text,
                                code: _codeController.text,
                              );
                        },
                  icon: isBusy
                      ? const SizedBox(
                          height: 18,
                          width: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.link),
                  label: const Text('Pair and connect'),
                ),
                if (widget.errorText != null) Text(widget.errorText!),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
