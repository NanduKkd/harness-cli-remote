import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models.dart';
import '../state/app_state.dart';
import '../widgets/chrome.dart';
import 'sessions_screen.dart';

class WorkspacesScreen extends ConsumerWidget {
  const WorkspacesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final workspaces = ref.watch(workspacesProvider);
    final realtime = ref.watch(realtimeServiceProvider);

    return AtmosphereScaffold(
      title: 'Gemini Remote',
      actions: [
        StreamBuilder<ConnectionStatus>(
          stream: realtime.statuses,
          initialData: realtime.status,
          builder: (context, snapshot) {
            final status = snapshot.data ?? ConnectionStatus.disconnected;
            return Padding(
              padding: const EdgeInsets.only(right: 12),
              child: Center(
                child: StatusPill(
                  label: connectionLabel(status),
                  color: connectionColor(status),
                ),
              ),
            );
          },
        ),
        IconButton(
          tooltip: 'Sign out',
          onPressed: () => ref.read(authControllerProvider.notifier).signOut(),
          icon: const Icon(Icons.logout),
        ),
      ],
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(workspacesProvider.future),
        child: workspaces.when(
          data: (items) => ListView.separated(
            padding: const EdgeInsets.all(20),
            itemBuilder: (context, index) {
              final workspace = items[index];
              return InkWell(
                borderRadius: BorderRadius.circular(24),
                onTap: () {
                  Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => SessionsScreen(workspace: workspace),
                    ),
                  );
                },
                child: SectionCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    spacing: 12,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              workspace.name,
                              style: Theme.of(context)
                                  .textTheme
                                  .titleLarge
                                  ?.copyWith(fontWeight: FontWeight.w700),
                            ),
                          ),
                          StatusPill(
                            label: workspace.hookStatus,
                            color: statusColor(workspace.hookStatus),
                          ),
                        ],
                      ),
                      Text(
                        workspace.rootPath,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      Text(
                        workspace.hookStatus == 'installed'
                            ? 'Ready for live streaming, tool telemetry, and resume-based follow-ups.'
                            : 'Run the host bootstrap command for this workspace before starting a session.',
                      ),
                    ],
                  ),
                ),
              );
            },
            separatorBuilder: (_, _) => const SizedBox(height: 14),
            itemCount: items.length,
          ),
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => ListView(
            padding: const EdgeInsets.all(20),
            children: [
              EmptyStateCard(
                title: 'Could not load workspaces',
                body: error.toString(),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
