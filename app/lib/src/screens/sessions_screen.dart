import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models.dart';
import '../state/app_state.dart';
import '../widgets/chrome.dart';
import 'session_detail_screen.dart';

class SessionsScreen extends ConsumerStatefulWidget {
  const SessionsScreen({super.key, required this.workspace});

  final Workspace workspace;

  @override
  ConsumerState<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends ConsumerState<SessionsScreen> {
  StreamSubscription<RealtimeEnvelope>? _messageSubscription;
  StreamSubscription<ConnectionStatus>? _statusSubscription;
  ConnectionStatus _connectionStatus = ConnectionStatus.disconnected;

  @override
  void initState() {
    super.initState();
    final realtime = ref.read(realtimeServiceProvider);
    _connectionStatus = realtime.status;
    _messageSubscription = realtime.messages.listen(_handleRealtimeEvent);
    _statusSubscription = realtime.statuses.listen(_handleConnectionStatus);
  }

  @override
  void dispose() {
    _messageSubscription?.cancel();
    _statusSubscription?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final sessions = ref.watch(sessionsProvider(widget.workspace.id));

    return AtmosphereScaffold(
      title: widget.workspace.name,
      floatingActionButton: FloatingActionButton.extended(
        key: const ValueKey('sessions-new-session-fab'),
        onPressed: () => _onNewSessionPressed(context, ref),
        icon: const Icon(Icons.play_circle_fill),
        label: const Text('New session'),
      ),
      body: RefreshIndicator(
        onRefresh: () =>
            ref.refresh(sessionsProvider(widget.workspace.id).future),
        child: sessions.when(
          data: (items) {
            if (items.isEmpty) {
              return ListView(
                padding: const EdgeInsets.all(10),
                children: [
                  EmptyStateCard(
                    title: 'No sessions yet',
                    body: widget.workspace.hookStatus == 'installed'
                        ? 'Start a new ${providerDisplayName(widget.workspace.provider)} turn for this workspace.'
                        : 'Bootstrap hooks on the host before creating sessions.',
                  ),
                ],
              );
            }

            return ListView.separated(
              padding: const EdgeInsets.all(10),
              itemBuilder: (context, index) {
                final session = items[index];
                final statusLabel = messageStatusLabel(
                  session.lastMessageStatus,
                );
                final statusTone = statusColor(session.lastMessageStatus);
                return InkWell(
                  borderRadius: BorderRadius.circular(16),
                  onTap: () {
                    Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => SessionDetailScreen(
                          workspace: widget.workspace,
                          session: session,
                        ),
                      ),
                    );
                  },
                  child: SectionCard(
                    padding: const EdgeInsets.fromLTRB(10, 10, 10, 9),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      spacing: 6,
                      children: [
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: Text(
                                _sessionTitle(session),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: Theme.of(context).textTheme.titleSmall
                                    ?.copyWith(fontWeight: FontWeight.w700),
                              ),
                            ),
                            const SizedBox(width: 10),
                            Text(
                              statusLabel,
                              style: Theme.of(context).textTheme.bodySmall
                                  ?.copyWith(
                                    color: statusTone,
                                    fontWeight: FontWeight.w700,
                                  ),
                            ),
                          ],
                        ),
                        Text(
                          'Last Updated ${_formatTime(session.lastActivityAt)}',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                        if (session.model != null)
                          Text(
                            'Model ${modelDisplayLabel(session.model)}',
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                      ],
                    ),
                  ),
                );
              },
              separatorBuilder: (_, _) => const SizedBox(height: 8),
              itemCount: items.length,
            );
          },
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => ListView(
            padding: const EdgeInsets.all(10),
            children: [
              EmptyStateCard(
                title: 'Could not load sessions',
                body: error.toString(),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _handleRealtimeEvent(RealtimeEnvelope envelope) {
    if (envelope.workspaceId != widget.workspace.id) {
      return;
    }

    if (_eventAffectsSessionSummary(envelope.event.type)) {
      ref.invalidate(sessionsProvider(widget.workspace.id));
    }
  }

  void _handleConnectionStatus(ConnectionStatus status) {
    final shouldCatchUp =
        _connectionStatus != ConnectionStatus.connected &&
        status == ConnectionStatus.connected;
    _connectionStatus = status;
    if (shouldCatchUp) {
      ref.invalidate(sessionsProvider(widget.workspace.id));
    }
  }

  Future<void> _openCreateDialog(BuildContext context, WidgetRef ref) async {
    final api = ref.read(apiClientProvider);
    if (api == null) {
      return;
    }

    final draft = await showModalBottomSheet<_SessionDraft>(
      context: context,
      isScrollControlled: true,
      builder: (_) =>
          _CreateSessionSheet(provider: widget.workspace.provider),
    );

    if (draft == null || draft.prompt.isEmpty) {
      return;
    }

    try {
      final session = await api.createSession(
        workspaceId: widget.workspace.id,
        prompt: draft.prompt,
        model: draft.model,
      );
      final auth = ref.read(authControllerProvider).valueOrNull;
      if (auth != null) {
        unawaited(
          ref
              .read(sessionMonitorBridgeProvider)
              .start(auth, sessionIds: [session.id]),
        );
      }
      ref.invalidate(sessionsProvider(widget.workspace.id));
      if (context.mounted) {
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => SessionDetailScreen(
              workspace: widget.workspace,
              session: session,
            ),
          ),
        );
      }
    } catch (error) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    }
  }

  void _onNewSessionPressed(BuildContext context, WidgetRef ref) {
    if (widget.workspace.hookStatus != 'installed') {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'This workspace is not ready yet. The host needs the ${providerDisplayName(widget.workspace.provider)} hook bridge installed before sessions can start.',
          ),
        ),
      );
      return;
    }

    _openCreateDialog(context, ref);
  }
}

bool _eventAffectsSessionSummary(String type) {
  return type == 'message.completed' ||
      type == 'run.started' ||
      type == 'run.completed' ||
      type == 'run.failed' ||
      type == 'run.cancelled';
}

String _formatTime(DateTime value) {
  final local = value;
  final hour = local.hour % 12 == 0 ? 12 : local.hour % 12;
  final minute = local.minute.toString().padLeft(2, '0');
  final suffix = local.hour >= 12 ? 'PM' : 'AM';
  return '${local.month}/${local.day} $hour:$minute $suffix';
}

const int _sessionTitleWordLimit = 14;

String _sessionTitle(RemoteSession session) {
  final prompt = session.lastPrompt?.trim() ?? '';
  if (prompt.isEmpty) {
    return session.id;
  }

  final compact = prompt.replaceAll(RegExp(r'\s+'), ' ');
  final words = compact.split(' ');
  if (words.length <= _sessionTitleWordLimit) {
    return compact;
  }
  return '${words.take(_sessionTitleWordLimit).join(' ')}...';
}

String? _normalizeModelInput(String raw) {
  final trimmed = raw.trim();
  return trimmed.isEmpty ? null : trimmed;
}

String? _selectedModelFromDropdown({
  required String selectedValue,
  required String customValue,
}) {
  if (selectedValue == defaultProviderModelValue) {
    return null;
  }

  if (selectedValue == customProviderModelValue) {
    return _normalizeModelInput(customValue);
  }

  return selectedValue;
}

class _SessionDraft {
  const _SessionDraft({required this.prompt, required this.model});

  final String prompt;
  final String? model;
}

class _CreateSessionSheet extends StatefulWidget {
  const _CreateSessionSheet({required this.provider});

  final String provider;

  @override
  State<_CreateSessionSheet> createState() => _CreateSessionSheetState();
}

class _CreateSessionSheetState extends State<_CreateSessionSheet> {
  late final TextEditingController _promptController;
  late final TextEditingController _customModelController;
  late String _selectedModelValue;

  @override
  void initState() {
    super.initState();
    _promptController = TextEditingController();
    _customModelController = TextEditingController();
    _selectedModelValue = defaultProviderModelValue;
  }

  @override
  void dispose() {
    _promptController.dispose();
    _customModelController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final modelOptions = providerModelOptions(widget.provider);
    final showCustomModel = _selectedModelValue == customProviderModelValue;

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 14,
          right: 14,
          top: 14,
          bottom: 14 + MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            spacing: 10,
            children: [
              Text(
                'Start a remote ${providerDisplayName(widget.provider)} session',
                style: Theme.of(
                  context,
                ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
              ),
              TextField(
                controller: _promptController,
                minLines: 2,
                maxLines: 5,
                decoration: const InputDecoration(
                  labelText: 'Initial prompt',
                ),
              ),
              DropdownButtonFormField<String>(
                key: ValueKey('session-model-$_selectedModelValue'),
                initialValue: _selectedModelValue,
                isExpanded: true,
                decoration: const InputDecoration(
                  labelText: 'Model',
                ),
                items: [
                  const DropdownMenuItem<String>(
                    value: defaultProviderModelValue,
                    child: Text('Use provider default'),
                  ),
                  ...modelOptions.map(
                    (option) => DropdownMenuItem<String>(
                      value: option.value,
                      child: Text(option.label),
                    ),
                  ),
                  const DropdownMenuItem<String>(
                    value: customProviderModelValue,
                    child: Text('Custom model id'),
                  ),
                ],
                onChanged: (value) {
                  setState(() {
                    _selectedModelValue = value ?? defaultProviderModelValue;
                  });
                },
              ),
              if (showCustomModel)
                TextField(
                  controller: _customModelController,
                  decoration: const InputDecoration(
                    labelText: 'Custom model id',
                  ),
                ),
              Text(
                providerModelHelperText(widget.provider),
                style: Theme.of(context).textTheme.bodySmall,
              ),
              FilledButton(
                onPressed: () => Navigator.of(context).pop(
                  _SessionDraft(
                    prompt: _promptController.text.trim(),
                    model: _selectedModelFromDropdown(
                      selectedValue: _selectedModelValue,
                      customValue: _customModelController.text,
                    ),
                  ),
                ),
                child: const Text('Start session'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
