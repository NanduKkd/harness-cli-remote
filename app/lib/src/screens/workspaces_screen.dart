import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models.dart';
import '../state/app_state.dart';
import '../widgets/chrome.dart';
import 'sessions_screen.dart';

class WorkspacesScreen extends ConsumerStatefulWidget {
  const WorkspacesScreen({super.key});

  @override
  ConsumerState<WorkspacesScreen> createState() => _WorkspacesScreenState();
}

class _WorkspacesScreenState extends ConsumerState<WorkspacesScreen> {
  final Set<String> _repairingWorkspaceIds = <String>{};
  String _providerFilter = 'all';

  @override
  Widget build(BuildContext context) {
    final workspaces = ref.watch(workspacesProvider);
    final realtime = ref.watch(realtimeServiceProvider);

    return AtmosphereScaffold(
      title: 'CLI Remote',
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _openCreateWorkspaceSheet,
        icon: const Icon(Icons.create_new_folder_outlined),
        label: const Text('Add workspace'),
      ),
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
        onRefresh: () async {
          final current = ref.read(workspacesProvider).valueOrNull ?? const [];
          for (final workspace in current) {
            ref.invalidate(sessionsProvider(workspace.id));
          }
          final refreshed = ref.refresh(workspacesProvider.future);
          await refreshed;
        },
        child: workspaces.when(
          data: (items) {
            final filtered = items.where((workspace) {
              if (_providerFilter == 'all') {
                return true;
              }
              return workspace.provider == _providerFilter;
            }).toList();

            return ListView(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
              children: [
                SectionCard(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 8,
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        flex: 4,
                        child: Text(
                          'Choose Provider',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.titleSmall
                              ?.copyWith(fontWeight: FontWeight.w700),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        flex: 5,
                        child: SegmentedButton<String>(
                          showSelectedIcon: false,
                          expandedInsets: EdgeInsets.zero,
                          style: ButtonStyle(
                            visualDensity: const VisualDensity(
                              horizontal: -3,
                              vertical: -3,
                            ),
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            padding: const WidgetStatePropertyAll(
                              EdgeInsets.symmetric(horizontal: 8, vertical: 0),
                            ),
                            textStyle: WidgetStatePropertyAll(
                              Theme.of(context).textTheme.bodySmall?.copyWith(
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                          segments: const [
                            ButtonSegment<String>(
                              value: 'all',
                              label: Text(
                                'All',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            ButtonSegment<String>(
                              value: 'gemini',
                              label: Text(
                                'Gemini',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            ButtonSegment<String>(
                              value: 'codex',
                              label: Text(
                                'Codex',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                          selected: {_providerFilter},
                          onSelectionChanged: (selection) {
                            setState(() {
                              _providerFilter = selection.first;
                            });
                          },
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 8),
                if (filtered.isEmpty)
                  const EmptyStateCard(
                    title: 'Nothing here',
                    body:
                        'Add or repair a workspace for this provider to continue.',
                  )
                else
                  ...filtered.map((workspace) {
                    final isRepairing = _repairingWorkspaceIds.contains(
                      workspace.id,
                    );
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(16),
                        onTap: () {
                          Navigator.of(context).push(
                            MaterialPageRoute<void>(
                              builder: (_) =>
                                  SessionsScreen(workspace: workspace),
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
                                children: [
                                  Expanded(
                                    child: Text(
                                      workspace.name,
                                      style: Theme.of(context)
                                          .textTheme
                                          .titleMedium
                                          ?.copyWith(
                                            fontWeight: FontWeight.w700,
                                          ),
                                    ),
                                  ),
                                  const SizedBox(width: 10),
                                  Text(
                                    providerDisplayName(workspace.provider),
                                    style: Theme.of(context).textTheme.bodySmall
                                        ?.copyWith(
                                          color: providerColor(
                                            workspace.provider,
                                          ),
                                          fontWeight: FontWeight.w700,
                                        ),
                                  ),
                                  const SizedBox(width: 4),
                                  if (isRepairing)
                                    const SizedBox(
                                      height: 18,
                                      width: 18,
                                      child: Padding(
                                        padding: EdgeInsets.all(2),
                                        child: CircularProgressIndicator(
                                          strokeWidth: 2,
                                        ),
                                      ),
                                    )
                                  else
                                    PopupMenuButton<_WorkspaceAction>(
                                      tooltip: 'Workspace actions',
                                      padding: EdgeInsets.zero,
                                      icon: const Icon(Icons.more_vert_rounded),
                                      onSelected: (action) {
                                        if (action ==
                                            _WorkspaceAction.repairHooks) {
                                          _repairWorkspace(workspace);
                                        }
                                      },
                                      itemBuilder: (context) => const [
                                        PopupMenuItem<_WorkspaceAction>(
                                          value: _WorkspaceAction.repairHooks,
                                          child: Text('Repair Hooks'),
                                        ),
                                      ],
                                    ),
                                ],
                              ),
                              Text(
                                workspace.rootPath,
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                              _WorkspaceActivityLine(workspace: workspace),
                            ],
                          ),
                        ),
                      ),
                    );
                  }),
              ],
            );
          },
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => ListView(
            padding: const EdgeInsets.all(10),
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

  Future<void> _repairWorkspace(Workspace workspace) async {
    final api = ref.read(apiClientProvider);
    if (api == null) {
      return;
    }

    setState(() {
      _repairingWorkspaceIds.add(workspace.id);
    });

    try {
      final repaired = await api.repairWorkspace(workspace.id);
      ref.invalidate(workspacesProvider);
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            repaired.repairedAt == null
                ? 'Repaired ${workspace.name}.'
                : 'Repaired ${workspace.name} at ${_formatTime(repaired.repairedAt!)}.',
          ),
        ),
      );
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(error.toString())));
      }
    } finally {
      if (mounted) {
        setState(() {
          _repairingWorkspaceIds.remove(workspace.id);
        });
      }
    }
  }

  Future<void> _openCreateWorkspaceSheet() async {
    final workspace = await showModalBottomSheet<Workspace>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _CreateWorkspaceSheet(),
    );

    if (workspace == null || !mounted) {
      return;
    }

    setState(() {
      _providerFilter = workspace.provider;
    });
    ref.invalidate(workspacesProvider);
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SessionsScreen(workspace: workspace),
      ),
    );
  }
}

enum _WorkspaceAction { repairHooks }

String _formatTime(DateTime value) {
  final hour = value.hour % 12 == 0 ? 12 : value.hour % 12;
  final minute = value.minute.toString().padLeft(2, '0');
  final suffix = value.hour >= 12 ? 'PM' : 'AM';
  return '${value.month}/${value.day} $hour:$minute $suffix';
}

class _WorkspaceActivityLine extends ConsumerWidget {
  const _WorkspaceActivityLine({required this.workspace});

  final Workspace workspace;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sessions = ref.watch(sessionsProvider(workspace.id));
    final style = Theme.of(context).textTheme.bodySmall;

    return sessions.when(
      data: (items) {
        if (items.isEmpty) {
          if (workspace.repairedAt != null) {
            return Text(
              'Last repaired ${_formatTime(workspace.repairedAt!)}',
              style: style,
            );
          }
          return Text('No activity yet', style: style);
        }

        final latest = items.reduce(
          (left, right) =>
              left.lastActivityAt.isAfter(right.lastActivityAt) ? left : right,
        );
        return Text(
          'Last activity ${_formatTime(latest.lastActivityAt)}',
          style: style,
        );
      },
      loading: () => Text('Loading activity...', style: style),
      error: (_, _) => Text(
        workspace.repairedAt != null
            ? 'Last repaired ${_formatTime(workspace.repairedAt!)}'
            : 'Activity unavailable',
        style: style,
      ),
    );
  }
}

class _CreateWorkspaceSheet extends ConsumerStatefulWidget {
  const _CreateWorkspaceSheet();

  @override
  ConsumerState<_CreateWorkspaceSheet> createState() =>
      _CreateWorkspaceSheetState();
}

class _CreateWorkspaceSheetState extends ConsumerState<_CreateWorkspaceSheet> {
  late final TextEditingController _nameController;
  late final TextEditingController _pathController;
  String _provider = 'gemini';
  bool _creating = false;
  String? _errorText;

  @override
  void initState() {
    super.initState();
    _nameController = TextEditingController();
    _pathController = TextEditingController();
  }

  @override
  void dispose() {
    _nameController.dispose();
    _pathController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
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
            spacing: 12,
            children: [
              Text(
                'Add workspace',
                style: Theme.of(
                  context,
                ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
              ),
              Text(
                'Choose the provider and point it at a host directory. You can type a path or browse folders on the host machine.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              TextField(
                controller: _nameController,
                textInputAction: TextInputAction.next,
                decoration: const InputDecoration(
                  labelText: 'Workspace name (optional)',
                  hintText: 'Defaults to the folder name',
                ),
              ),
              SegmentedButton<String>(
                showSelectedIcon: false,
                segments: const [
                  ButtonSegment<String>(value: 'gemini', label: Text('Gemini')),
                  ButtonSegment<String>(value: 'codex', label: Text('Codex')),
                ],
                selected: {_provider},
                onSelectionChanged: _creating
                    ? null
                    : (selection) {
                        setState(() {
                          _provider = selection.first;
                        });
                      },
              ),
              TextField(
                controller: _pathController,
                minLines: 1,
                maxLines: 2,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _createWorkspace(),
                decoration: const InputDecoration(
                  labelText: 'Host path',
                  hintText: '/absolute/path/to/project',
                ),
              ),
              Row(
                children: [
                  OutlinedButton.icon(
                    onPressed: _creating ? null : _browseForPath,
                    icon: const Icon(Icons.folder_open_outlined),
                    label: const Text('Browse folders'),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: _creating ? null : _createWorkspace,
                      icon: _creating
                          ? const SizedBox(
                              height: 16,
                              width: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.add_circle_outline),
                      label: Text(
                        _creating ? 'Creating...' : 'Create workspace',
                      ),
                    ),
                  ),
                ],
              ),
              if (_errorText != null)
                Text(
                  _errorText!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _browseForPath() async {
    final path = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _DirectoryPickerSheet(initialPath: _pathController.text),
    );

    if (path == null || !mounted) {
      return;
    }

    _pathController.text = path;
    _pathController.selection = TextSelection.collapsed(offset: path.length);
  }

  Future<void> _createWorkspace() async {
    final api = ref.read(apiClientProvider);
    if (api == null) {
      return;
    }

    final rootPath = _pathController.text.trim();
    if (rootPath.isEmpty) {
      setState(() {
        _errorText = 'Enter or choose a host path.';
      });
      return;
    }

    setState(() {
      _creating = true;
      _errorText = null;
    });

    try {
      final workspace = await api.createWorkspace(
        name: _nameController.text.trim(),
        rootPath: rootPath,
        provider: _provider,
      );
      if (!mounted) {
        return;
      }
      Navigator.of(context).pop(workspace);
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _errorText = error.toString();
      });
    } finally {
      if (mounted) {
        setState(() {
          _creating = false;
        });
      }
    }
  }
}

class _DirectoryPickerSheet extends ConsumerStatefulWidget {
  const _DirectoryPickerSheet({required this.initialPath});

  final String initialPath;

  @override
  ConsumerState<_DirectoryPickerSheet> createState() =>
      _DirectoryPickerSheetState();
}

class _DirectoryPickerSheetState extends ConsumerState<_DirectoryPickerSheet> {
  DirectoryListing? _listing;
  bool _loading = true;
  String? _errorText;

  @override
  void initState() {
    super.initState();
    _load(widget.initialPath.trim().isEmpty ? null : widget.initialPath.trim());
  }

  @override
  Widget build(BuildContext context) {
    final listing = _listing;

    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.72,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Choose host folder',
                style: Theme.of(
                  context,
                ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 8),
              Text(
                listing?.currentPath ?? 'Loading directories...',
                style: Theme.of(context).textTheme.bodySmall,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  OutlinedButton.icon(
                    onPressed: _loading || listing?.parentPath == null
                        ? null
                        : () => _load(listing!.parentPath),
                    icon: const Icon(Icons.arrow_upward_rounded),
                    label: const Text('Up'),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: listing == null
                          ? null
                          : () =>
                                Navigator.of(context).pop(listing.currentPath),
                      icon: const Icon(Icons.check_circle_outline),
                      label: const Text('Use this folder'),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Expanded(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: const Color(0xFFE4D5C6)),
                  ),
                  child: _loading
                      ? const Center(child: CircularProgressIndicator())
                      : _errorText != null
                      ? Padding(
                          padding: const EdgeInsets.all(14),
                          child: Text(
                            _errorText!,
                            style: TextStyle(
                              color: Theme.of(context).colorScheme.error,
                            ),
                          ),
                        )
                      : ListView.separated(
                          padding: const EdgeInsets.all(8),
                          itemCount: listing?.directories.length ?? 0,
                          separatorBuilder: (_, _) => const SizedBox(height: 4),
                          itemBuilder: (context, index) {
                            final directory = listing!.directories[index];
                            return ListTile(
                              dense: true,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(12),
                              ),
                              leading: const Icon(Icons.folder_outlined),
                              title: Text(
                                directory.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              subtitle: Text(
                                directory.path,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              trailing: const Icon(Icons.chevron_right_rounded),
                              onTap: () => _load(directory.path),
                            );
                          },
                        ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _load(String? path) async {
    final api = ref.read(apiClientProvider);
    if (api == null) {
      return;
    }

    setState(() {
      _loading = true;
      _errorText = null;
    });

    try {
      final listing = await api.browseDirectories(path: path);
      if (!mounted) {
        return;
      }
      setState(() {
        _listing = listing;
      });
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _errorText = error.toString();
      });
    } finally {
      if (mounted) {
        setState(() {
          _loading = false;
        });
      }
    }
  }
}
