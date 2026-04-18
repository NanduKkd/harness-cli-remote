import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models.dart';
import '../state/app_state.dart';
import '../theme.dart';
import '../widgets/chrome.dart';

class SessionArtifactsScreen extends ConsumerStatefulWidget {
  const SessionArtifactsScreen({
    super.key,
    required this.workspace,
    required this.session,
  });

  final Workspace workspace;
  final RemoteSession session;

  @override
  ConsumerState<SessionArtifactsScreen> createState() =>
      _SessionArtifactsScreenState();
}

class _SessionArtifactsScreenState
    extends ConsumerState<SessionArtifactsScreen> {
  List<SessionEvent> _events = const [];
  Set<String> _downloadingArtifactIds = <String>{};
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_loadArtifacts());
  }

  @override
  Widget build(BuildContext context) {
    final artifacts = _collectArtifacts(_events).reversed.toList();

    return AtmosphereScaffold(
      title: 'Artifacts',
      body: RefreshIndicator(
        onRefresh: _loadArtifacts,
        child: ListView(
          padding: const EdgeInsets.all(10),
          children: [
            SectionCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                spacing: 6,
                children: [
                  Text(
                    widget.workspace.name,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  Text(
                    'Session ${widget.session.id}',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            if (_loading)
              const Padding(
                padding: EdgeInsets.only(top: 28),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_error != null)
              EmptyStateCard(title: 'Could not load artifacts', body: _error!)
            else if (artifacts.isEmpty)
              const EmptyStateCard(
                title: 'No artifacts yet',
                body:
                    'Files shared during this session will appear here once Gemini or Codex publishes them.',
              )
            else
              ...artifacts.map(
                (artifact) => Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: _ArtifactCard(
                    artifact: artifact,
                    downloading: _downloadingArtifactIds.contains(artifact.id),
                    onDownload: artifact.downloadPath == null
                        ? null
                        : () => _downloadArtifact(artifact),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _loadArtifacts() async {
    final api = ref.read(apiClientProvider);
    if (api == null) {
      if (!mounted) {
        return;
      }
      setState(() {
        _loading = false;
        _error = 'You are not paired with a host.';
      });
      return;
    }

    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }

    try {
      final events = await api.getEvents(
        sessionId: widget.session.id,
        afterSeq: 0,
      );
      if (!mounted) {
        return;
      }
      setState(() {
        _events = events;
        _loading = false;
        _error = null;
      });
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _loading = false;
        _error = error.toString();
      });
    }
  }

  Future<void> _downloadArtifact(_ArtifactEntry artifact) async {
    final api = ref.read(apiClientProvider);
    final auth = ref.read(authControllerProvider).valueOrNull;
    final downloadPath = artifact.downloadPath;

    if (api == null || auth == null) {
      _showSnackBar('You are not paired with a host.');
      return;
    }

    if (downloadPath == null || downloadPath.isEmpty) {
      _showSnackBar('This artifact is missing a download URL.');
      return;
    }

    setState(() {
      _downloadingArtifactIds = {..._downloadingArtifactIds, artifact.id};
    });

    try {
      await ref
          .read(artifactDownloadBridgeProvider)
          .enqueueArtifactDownload(
            url: api.resolvePath(downloadPath),
            token: auth.token,
            filename: artifact.title,
            mimeType: artifact.mimeType,
          );
      _showSnackBar('Download started for ${artifact.title}.');
    } catch (error) {
      _showSnackBar(error.toString());
    } finally {
      if (mounted) {
        setState(() {
          _downloadingArtifactIds = {..._downloadingArtifactIds}
            ..remove(artifact.id);
        });
      }
    }
  }

  void _showSnackBar(String message) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }
}

class _ArtifactCard extends StatelessWidget {
  const _ArtifactCard({
    required this.artifact,
    required this.downloading,
    required this.onDownload,
  });

  final _ArtifactEntry artifact;
  final bool downloading;
  final VoidCallback? onDownload;

  @override
  Widget build(BuildContext context) {
    return SectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        spacing: 10,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: AppPalette.artifactSurface,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: const Icon(Icons.attach_file_rounded),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  spacing: 4,
                  children: [
                    Text(
                      artifact.title,
                      style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    Text(
                      _formatTimestamp(artifact.ts),
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (artifact.path != null)
            _MetadataLine(label: 'Path', value: artifact.path!),
          if (artifact.mimeType != null)
            _MetadataLine(label: 'Type', value: artifact.mimeType!),
          if (artifact.sizeBytes != null)
            _MetadataLine(
              label: 'Size',
              value: _formatBytes(artifact.sizeBytes!),
            ),
          if (onDownload != null || downloading)
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton.icon(
                onPressed: downloading ? null : onDownload,
                icon: downloading
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.download_rounded),
                label: Text(downloading ? 'Starting...' : 'Download'),
              ),
            ),
        ],
      ),
    );
  }
}

class _MetadataLine extends StatelessWidget {
  const _MetadataLine({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return RichText(
      text: TextSpan(
        style: Theme.of(context).textTheme.bodyMedium,
        children: [
          TextSpan(
            text: '$label: ',
            style: const TextStyle(fontWeight: FontWeight.w700),
          ),
          TextSpan(text: value),
        ],
      ),
    );
  }
}

class _ArtifactEntry {
  const _ArtifactEntry({
    required this.id,
    required this.title,
    required this.ts,
    this.path,
    this.mimeType,
    this.sizeBytes,
    this.downloadPath,
  });

  final String id;
  final String title;
  final DateTime ts;
  final String? path;
  final String? mimeType;
  final int? sizeBytes;
  final String? downloadPath;
}

List<_ArtifactEntry> _collectArtifacts(List<SessionEvent> events) {
  final entries = <String, _ArtifactEntry>{};

  for (final event in events) {
    final entry = switch (event.type) {
      'artifact.shared' => _artifactFromSharedEvent(event),
      'tool.completed' => _artifactFromToolEvent(event),
      _ => null,
    };

    if (entry != null) {
      entries[entry.id] = entry;
    }
  }

  return entries.values.toList()
    ..sort((left, right) => left.ts.compareTo(right.ts));
}

_ArtifactEntry? _artifactFromSharedEvent(SessionEvent event) {
  final payload = event.payload;
  final artifactId = _stringOrNull(payload['artifactId']);
  final path = _stringOrNull(payload['path']);
  final title =
      _stringOrNull(payload['title']) ??
      _stringOrNull(payload['filename']) ??
      _stringOrNull(payload['fileName']) ??
      _stringOrNull(payload['name']) ??
      _basename(path) ??
      'Shared file';

  return _ArtifactEntry(
    id: artifactId ?? 'event-${event.seq}',
    title: title,
    ts: event.ts,
    path: path,
    mimeType: _stringOrNull(payload['mimeType']),
    sizeBytes: _intOrNull(payload['sizeBytes'] ?? payload['size']),
    downloadPath: _normalizeDownloadPath(
      _stringOrNull(payload['downloadPath']) ??
          _stringOrNull(payload['download_path']) ??
          _stringOrNull(payload['downloadUrl']) ??
          _stringOrNull(payload['download_url']),
      artifactId: artifactId,
    ),
  );
}

_ArtifactEntry? _artifactFromToolEvent(SessionEvent event) {
  final toolName = (_stringOrNull(event.payload['toolName']) ?? '')
      .toLowerCase()
      .replaceAll('_', '')
      .replaceAll('-', '');
  if (toolName != 'sharefile') {
    return null;
  }

  final rawResponse = event.payload['toolResponse'];
  final rawInput = event.payload['toolInput'];
  final response = rawResponse is Map
      ? Map<String, dynamic>.from(rawResponse)
      : const <String, dynamic>{};
  final structuredResponse = response['structuredContent'];
  final responseBody = structuredResponse is Map
      ? Map<String, dynamic>.from(structuredResponse)
      : response;
  final input = rawInput is Map
      ? Map<String, dynamic>.from(rawInput)
      : const <String, dynamic>{};

  final artifactId =
      _stringOrNull(responseBody['artifactId']) ??
      _stringOrNull(response['artifactId']);
  final path =
      _stringOrNull(responseBody['path']) ??
      _stringOrNull(response['path']) ??
      _stringOrNull(input['path']);
  final title =
      _stringOrNull(responseBody['title']) ??
      _stringOrNull(responseBody['filename']) ??
      _stringOrNull(responseBody['fileName']) ??
      _stringOrNull(response['title']) ??
      _stringOrNull(response['filename']) ??
      _stringOrNull(response['fileName']) ??
      _basename(path) ??
      'Shared file';

  return _ArtifactEntry(
    id: artifactId ?? '${event.runId ?? 'run'}-${event.seq}',
    title: title,
    ts: event.ts,
    path: path,
    mimeType:
        _stringOrNull(responseBody['mimeType']) ??
        _stringOrNull(response['mimeType']) ??
        _stringOrNull(input['mimeType']),
    sizeBytes: _intOrNull(
      responseBody['sizeBytes'] ??
          responseBody['size'] ??
          response['sizeBytes'] ??
          response['size'],
    ),
    downloadPath: _normalizeDownloadPath(
      _stringOrNull(responseBody['downloadPath']) ??
          _stringOrNull(responseBody['download_path']) ??
          _stringOrNull(responseBody['downloadUrl']) ??
          _stringOrNull(responseBody['download_url']) ??
          _stringOrNull(response['downloadPath']) ??
          _stringOrNull(response['download_path']) ??
          _stringOrNull(response['downloadUrl']) ??
          _stringOrNull(response['download_url']),
      artifactId: artifactId,
    ),
  );
}

String _formatTimestamp(DateTime value) {
  final hour = value.hour % 12 == 0 ? 12 : value.hour % 12;
  final minute = value.minute.toString().padLeft(2, '0');
  final suffix = value.hour >= 12 ? 'PM' : 'AM';
  return '${value.month}/${value.day} $hour:$minute $suffix';
}

String _formatBytes(int value) {
  if (value < 1024) {
    return '$value B';
  }
  if (value < 1024 * 1024) {
    return '${(value / 1024).toStringAsFixed(1)} KB';
  }
  if (value < 1024 * 1024 * 1024) {
    return '${(value / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
  return '${(value / (1024 * 1024 * 1024)).toStringAsFixed(1)} GB';
}

String? _stringOrNull(Object? value) {
  if (value is! String) {
    return null;
  }
  final trimmed = value.trim();
  return trimmed.isEmpty ? null : trimmed;
}

int? _intOrNull(Object? value) {
  if (value is int) {
    return value;
  }
  if (value is num) {
    return value.toInt();
  }
  if (value is String) {
    return int.tryParse(value.trim());
  }
  return null;
}

String? _normalizeDownloadPath(String? value, {String? artifactId}) {
  if (value != null) {
    final trimmed = value.trim();
    if (trimmed.isNotEmpty) {
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        final uri = Uri.tryParse(trimmed);
        final path = uri?.path;
        if (path != null && path.isNotEmpty) {
          return path;
        }
      }

      return trimmed.startsWith('/') ? trimmed : '/$trimmed';
    }
  }

  final normalizedArtifactId = artifactId?.trim();
  if (normalizedArtifactId == null || normalizedArtifactId.isEmpty) {
    return null;
  }
  return '/artifacts/$normalizedArtifactId/download';
}

String? _basename(String? value) {
  if (value == null || value.isEmpty) {
    return null;
  }

  final normalized = value.replaceAll('\\', '/');
  final pieces = normalized.split('/');
  if (pieces.isEmpty) {
    return null;
  }
  final last = pieces.last.trim();
  return last.isEmpty ? null : last;
}
