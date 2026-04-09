import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models.dart';
import '../state/app_state.dart';
import '../widgets/chrome.dart';
import 'session_detail_screen.dart';

class SessionsScreen extends ConsumerWidget {
  const SessionsScreen({super.key, required this.workspace});

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
                padding: const EdgeInsets.all(10),
                children: [
                  EmptyStateCard(
                    title: 'No sessions yet',
                    body: workspace.hookStatus == 'installed'
                        ? 'Start a new ${providerDisplayName(workspace.provider)} turn for this workspace.'
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
                          workspace: workspace,
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
                                session.id,
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
            left: 14,
            right: 14,
            top: 14,
            bottom: 14 + MediaQuery.viewInsetsOf(context).bottom,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            spacing: 10,
            children: [
              Text(
                'Start a remote ${providerDisplayName(workspace.provider)} session',
                style: Theme.of(
                  context,
                ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
              ),
              TextField(
                controller: controller,
                minLines: 2,
                maxLines: 5,
                decoration: const InputDecoration(labelText: 'Initial prompt'),
              ),
              FilledButton(
                onPressed: () =>
                    Navigator.of(context).pop(controller.text.trim()),
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
            builder: (_) =>
                SessionDetailScreen(workspace: workspace, session: session),
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
    if (workspace.hookStatus != 'installed') {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'This workspace is not ready yet. The host needs the ${providerDisplayName(workspace.provider)} hook bridge installed before sessions can start.',
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
