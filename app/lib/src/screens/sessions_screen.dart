import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models.dart';
import '../state/app_state.dart';
import '../widgets/chrome.dart';
import 'session_detail_screen.dart';

class SessionsScreen extends ConsumerWidget {
  const SessionsScreen({
    super.key,
    required this.workspace,
  });

  final Workspace workspace;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sessions = ref.watch(sessionsProvider(workspace.id));

    return AtmosphereScaffold(
      title: workspace.name,
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _onNewSessionPressed(context, ref),
        icon: const Icon(Icons.play_circle_fill),
        label: const Text('New session'),
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(sessionsProvider(workspace.id).future),
        child: sessions.when(
          data: (items) {
            if (items.isEmpty) {
              return ListView(
                padding: const EdgeInsets.all(20),
                children: [
                  EmptyStateCard(
                    title: 'No sessions yet',
                    body: workspace.hookStatus == 'installed'
                        ? 'Start a new Gemini turn for this workspace.'
                        : 'Bootstrap hooks on the host before creating sessions.',
                  ),
                ],
              );
            }

            return ListView.separated(
              padding: const EdgeInsets.all(20),
              itemBuilder: (context, index) {
                final session = items[index];
                return InkWell(
                  borderRadius: BorderRadius.circular(24),
                  onTap: () {
                    Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => SessionDetailScreen(
                          workspace: workspace,
                          session: session,
                        ),
                      ),
                    );
                  },
                  child: SectionCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      spacing: 10,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                session.id,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: Theme.of(context)
                                    .textTheme
                                    .titleMedium
                                    ?.copyWith(fontWeight: FontWeight.w700),
                              ),
                            ),
                            StatusPill(
                              label: session.status,
                              color: statusColor(session.status),
                            ),
                          ],
                        ),
                        Text(
                          'Updated ${_formatTime(session.updatedAt)}',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                        if (session.geminiSessionId != null)
                          Text(
                            'Gemini session: ${session.geminiSessionId}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                      ],
                    ),
                  ),
                );
              },
              separatorBuilder: (_, _) => const SizedBox(height: 14),
              itemCount: items.length,
            );
          },
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => ListView(
            padding: const EdgeInsets.all(20),
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

  Future<void> _openCreateDialog(BuildContext context, WidgetRef ref) async {
    final controller = TextEditingController();
    final api = ref.read(apiClientProvider);
    if (api == null) {
      return;
    }

    final prompt = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (context) {
        return Padding(
          padding: EdgeInsets.only(
            left: 20,
            right: 20,
            top: 20,
            bottom: 20 + MediaQuery.viewInsetsOf(context).bottom,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            spacing: 12,
            children: [
              Text(
                'Start a remote Gemini session',
                style: Theme.of(context)
                    .textTheme
                    .titleLarge
                    ?.copyWith(fontWeight: FontWeight.w700),
              ),
              TextField(
                controller: controller,
                minLines: 3,
                maxLines: 6,
                decoration: const InputDecoration(
                  labelText: 'Initial prompt',
                ),
              ),
              FilledButton(
                onPressed: () => Navigator.of(context).pop(controller.text.trim()),
                child: const Text('Start session'),
              ),
            ],
          ),
        );
      },
    );

    if (prompt == null || prompt.isEmpty) {
      return;
    }

    try {
      final session = await api.createSession(
        workspaceId: workspace.id,
        prompt: prompt,
      );
      ref.invalidate(sessionsProvider(workspace.id));
      if (context.mounted) {
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => SessionDetailScreen(
              workspace: workspace,
              session: session,
            ),
          ),
        );
      }
    } catch (error) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(error.toString())),
        );
      }
    }
  }

  void _onNewSessionPressed(BuildContext context, WidgetRef ref) {
    if (workspace.hookStatus != 'installed') {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'This workspace is not ready yet. The host needs the Gemini Remote hook bridge installed before sessions can start.',
          ),
        ),
      );
      return;
    }

    _openCreateDialog(context, ref);
  }
}

String _formatTime(DateTime value) {
  final local = value;
  final hour = local.hour % 12 == 0 ? 12 : local.hour % 12;
  final minute = local.minute.toString().padLeft(2, '0');
  final suffix = local.hour >= 12 ? 'PM' : 'AM';
  return '${local.month}/${local.day} $hour:$minute $suffix';
}
