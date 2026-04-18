import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../base_url.dart';
import '../state/app_state.dart';
import '../widgets/chrome.dart';

class PairScreen extends ConsumerStatefulWidget {
  const PairScreen({super.key, this.errorText});

  final String? errorText;

  @override
  ConsumerState<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends ConsumerState<PairScreen> {
  late final TextEditingController _hostController;
  late final TextEditingController _codeController;

  bool _isCheckingHost = false;
  bool _isPairing = false;
  String? _statusText;
  Color? _statusColor;
  String? _lastCheckedHost;
  bool _appliedRecentHost = false;

  @override
  void initState() {
    super.initState();
    _hostController = TextEditingController();
    _codeController = TextEditingController();
    _hostController.addListener(_handleInputChanged);
    _codeController.addListener(_handleInputChanged);
  }

  @override
  void dispose() {
    _hostController
      ..removeListener(_handleInputChanged)
      ..dispose();
    _codeController
      ..removeListener(_handleInputChanged)
      ..dispose();
    super.dispose();
  }

  void _handleInputChanged() {
    if (!mounted) {
      return;
    }

    final host = _hostController.text.trim();
    setState(() {
      if (host != _lastCheckedHost) {
        _statusText = null;
        _statusColor = null;
      }
    });
  }

  void _setStatus(String text, Color color) {
    if (!mounted) {
      return;
    }

    setState(() {
      _statusText = text;
      _statusColor = color;
      _lastCheckedHost = _hostController.text.trim();
    });
  }

  void _showSnackBar(String text) {
    if (!mounted) {
      return;
    }

    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  String? _normalizedHost([bool showErrors = true]) {
    final raw = _hostController.text.trim();
    if (raw.isEmpty) {
      if (showErrors) {
        _showSnackBar('Enter the host URL first.');
      }
      return null;
    }

    try {
      return normalizeBaseUrl(raw);
    } on FormatException catch (error) {
      if (showErrors) {
        _showSnackBar(error.message);
      }
      return null;
    }
  }

  Future<bool> _probeHost(String baseUrl) async {
    final client = ref.read(httpClientProvider);
    final uri = resolveBaseUrlPath(baseUrl, '/health');
    final response = await client.get(uri).timeout(const Duration(seconds: 4));
    if (response.statusCode >= 400) {
      throw Exception('Host responded with ${response.statusCode}.');
    }

    final body = response.body.trim();
    if (body.isEmpty) {
      return true;
    }

    final decoded = jsonDecode(body);
    if (decoded is Map<String, dynamic> && decoded['ok'] == true) {
      return true;
    }

    throw Exception('Host did not return a healthy response.');
  }

  Future<void> _pasteHost() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text?.trim() ?? '';
    if (text.isEmpty) {
      _showSnackBar('Clipboard does not contain a host URL.');
      return;
    }

    _hostController.text = text;
    _hostController.selection = TextSelection.collapsed(offset: text.length);
  }

  void _clearHost() {
    setState(() {
      _hostController.clear();
      _statusText = null;
      _statusColor = null;
      _lastCheckedHost = null;
    });
  }

  Future<void> _checkHost() async {
    if (_isCheckingHost || _isPairing) {
      return;
    }

    final colorScheme = Theme.of(context).colorScheme;
    final baseUrl = _normalizedHost();
    if (baseUrl == null) {
      return;
    }

    FocusScope.of(context).unfocus();
    setState(() {
      _isCheckingHost = true;
    });

    try {
      await _probeHost(baseUrl);
      _setStatus('Host reachable at $baseUrl.', colorScheme.primary);
    } on TimeoutException {
      _setStatus('Host check timed out for $baseUrl.', colorScheme.error);
      _showSnackBar('Timed out reaching $baseUrl.');
    } catch (error) {
      _setStatus('Could not reach $baseUrl.', colorScheme.error);
      _showSnackBar(error.toString());
    } finally {
      if (mounted) {
        setState(() {
          _isCheckingHost = false;
        });
      }
    }
  }

  Future<void> _pair() async {
    if (_isCheckingHost || _isPairing) {
      return;
    }

    final colorScheme = Theme.of(context).colorScheme;
    final baseUrl = _normalizedHost();
    if (baseUrl == null) {
      return;
    }

    final code = _codeController.text.trim();
    if (code.isEmpty) {
      _showSnackBar('Enter the pairing code from the host.');
      return;
    }

    FocusScope.of(context).unfocus();
    setState(() {
      _isPairing = true;
    });

    try {
      await _probeHost(baseUrl);
      await ref
          .read(authControllerProvider.notifier)
          .pair(baseUrl: baseUrl, code: code);
      _setStatus(
        'Pairing succeeded. Opening your workspaces...',
        colorScheme.primary,
      );
    } on TimeoutException {
      _setStatus('Host check timed out for $baseUrl.', colorScheme.error);
      _showSnackBar('Timed out reaching $baseUrl.');
    } catch (error) {
      _setStatus('Pairing failed for $baseUrl.', colorScheme.error);
      _showSnackBar(error.toString());
    } finally {
      if (mounted) {
        setState(() {
          _isPairing = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final recentHosts = ref.watch(recentHostsProvider);
    final isBusy = _isCheckingHost || _isPairing;
    final hostValue = _hostController.text.trim();

    ref.listen<AsyncValue<List<String>>>(recentHostsProvider, (previous, next) {
      next.whenData((hosts) {
        if (_appliedRecentHost ||
            _hostController.text.trim().isNotEmpty ||
            hosts.isEmpty) {
          return;
        }

        _appliedRecentHost = true;
        _hostController.text = hosts.first;
        _hostController.selection = TextSelection.collapsed(
          offset: hosts.first.length,
        );
      });
    });

    return AtmosphereScaffold(
      title: 'Code Remotely',
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const SectionCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              spacing: 12,
              children: [
                Text(
                  'Connect your phone to the remote host daemon running on your computer.',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
                ),
                Text(
                  'Paste the host URL, verify it is reachable, then enter the pairing code printed by the daemon.',
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
                const Text(
                  'Host URL',
                  style: TextStyle(fontWeight: FontWeight.w700),
                ),
                TextField(
                  key: const ValueKey('pair-host-field'),
                  controller: _hostController,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  textInputAction: TextInputAction.next,
                  decoration: InputDecoration(
                    hintText: 'http://host:8918',
                    suffixIcon: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        IconButton(
                          tooltip: 'Paste host URL',
                          onPressed: isBusy ? null : _pasteHost,
                          icon: const Icon(Icons.content_paste),
                        ),
                        IconButton(
                          tooltip: 'Clear host URL',
                          onPressed: isBusy || hostValue.isEmpty
                              ? null
                              : _clearHost,
                          icon: const Icon(Icons.clear),
                        ),
                      ],
                    ),
                  ),
                ),
                recentHosts.when(
                  data: (hosts) {
                    if (hosts.isEmpty) {
                      return const SizedBox.shrink();
                    }

                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      spacing: 10,
                      children: [
                        const Text(
                          'Recent hosts',
                          style: TextStyle(fontWeight: FontWeight.w700),
                        ),
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: hosts
                              .map(
                                (host) => InputChip(
                                  label: Text(host),
                                  onPressed: isBusy
                                      ? null
                                      : () {
                                          _hostController.text = host;
                                          _hostController.selection =
                                              TextSelection.collapsed(
                                                offset: host.length,
                                              );
                                        },
                                ),
                              )
                              .toList(growable: false),
                        ),
                      ],
                    );
                  },
                  loading: () => const SizedBox.shrink(),
                  error: (error, stackTrace) => const SizedBox.shrink(),
                ),
                const Text(
                  'Pairing code',
                  style: TextStyle(fontWeight: FontWeight.w700),
                ),
                TextField(
                  key: const ValueKey('pair-code-field'),
                  controller: _codeController,
                  keyboardType: TextInputType.text,
                  textInputAction: TextInputAction.done,
                  onSubmitted: (_) => _pair(),
                  decoration: const InputDecoration(hintText: '123-456'),
                ),
                Row(
                  children: [
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: isBusy ? null : _pair,
                        icon: _isPairing
                            ? const SizedBox(
                                height: 18,
                                width: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.link),
                        label: Text(
                          _isPairing ? 'Pairing...' : 'Pair and connect',
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    TextButton.icon(
                      onPressed: isBusy ? null : _checkHost,
                      icon: _isCheckingHost
                          ? const SizedBox(
                              height: 18,
                              width: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.health_and_safety),
                      label: Text(_isCheckingHost ? 'Checking' : 'Check host'),
                    ),
                  ],
                ),
                if (_statusText != null)
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    spacing: 8,
                    children: [
                      Icon(
                        _statusColor == Theme.of(context).colorScheme.error
                            ? Icons.error_outline
                            : Icons.check_circle_outline,
                        color: _statusColor,
                      ),
                      Expanded(
                        child: Text(
                          _statusText!,
                          style: TextStyle(
                            color: _statusColor,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ],
                  ),
                if (widget.errorText != null)
                  Text(
                    widget.errorText!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
