import 'base_url.dart';

enum ConnectionStatus { disconnected, connecting, connected }

class AuthSession {
  const AuthSession({required this.baseUrl, required this.token});

  final String baseUrl;
  final String token;

  Uri get httpUri => Uri.parse(baseUrl);

  Uri get websocketUri {
    final websocket = resolveBaseUrlPath(
      baseUrl,
      '/ws',
      queryParameters: {'token': token},
    );
    return websocket.replace(scheme: httpUri.scheme == 'https' ? 'wss' : 'ws');
  }
}

class Workspace {
  const Workspace({
    required this.id,
    required this.name,
    required this.rootPath,
    required this.provider,
    required this.hookStatus,
    this.repairedAt,
  });

  factory Workspace.fromJson(Map<String, dynamic> json) {
    return Workspace(
      id: json['id'] as String,
      name: json['name'] as String,
      rootPath: json['rootPath'] as String,
      provider: (json['provider'] as String?) ?? 'gemini',
      hookStatus: json['hookStatus'] as String? ?? 'missing',
      repairedAt: _parseDateTime(json['repairedAt']),
    );
  }

  final String id;
  final String name;
  final String rootPath;
  final String provider;
  final String hookStatus;
  final DateTime? repairedAt;

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'rootPath': rootPath,
      'provider': provider,
      'hookStatus': hookStatus,
      if (repairedAt != null)
        'repairedAt': repairedAt!.toUtc().toIso8601String(),
    };
  }
}

class DirectoryEntry {
  const DirectoryEntry({required this.name, required this.path});

  factory DirectoryEntry.fromJson(Map<String, dynamic> json) {
    return DirectoryEntry(
      name: json['name'] as String,
      path: json['path'] as String,
    );
  }

  final String name;
  final String path;
}

class DirectoryListing {
  const DirectoryListing({
    required this.currentPath,
    required this.parentPath,
    required this.directories,
  });

  factory DirectoryListing.fromJson(Map<String, dynamic> json) {
    return DirectoryListing(
      currentPath: json['currentPath'] as String,
      parentPath: json['parentPath'] as String?,
      directories: (json['directories'] as List<dynamic>? ?? const [])
          .map(
            (item) =>
                DirectoryEntry.fromJson(Map<String, dynamic>.from(item as Map)),
          )
          .toList(),
    );
  }

  final String currentPath;
  final String? parentPath;
  final List<DirectoryEntry> directories;
}

class ProviderModelOption {
  const ProviderModelOption({required this.value, required this.label});

  final String value;
  final String label;
}

const String defaultProviderModelValue = '__default__';
const String customProviderModelValue = '__custom__';

class RemoteSession {
  const RemoteSession({
    required this.id,
    required this.workspaceId,
    required this.model,
    required this.providerSessionId,
    required this.geminiSessionId,
    required this.transcriptPath,
    required this.status,
    required this.lastMessageStatus,
    required this.createdAt,
    required this.updatedAt,
    required this.lastActivityAt,
    required this.lastRunId,
    this.lastPrompt,
  });

  factory RemoteSession.fromJson(Map<String, dynamic> json) {
    return RemoteSession(
      id: json['id'] as String,
      workspaceId: json['workspaceId'] as String,
      model: json['model'] as String?,
      providerSessionId:
          (json['providerSessionId'] as String?) ??
          (json['geminiSessionId'] as String?),
      geminiSessionId: json['geminiSessionId'] as String?,
      transcriptPath: json['transcriptPath'] as String?,
      status: json['status'] as String,
      lastMessageStatus: (json['lastMessageStatus'] as String?) ?? 'idle',
      createdAt: DateTime.parse(json['createdAt'] as String).toLocal(),
      updatedAt: DateTime.parse(json['updatedAt'] as String).toLocal(),
      lastActivityAt:
          _parseDateTime(json['lastActivityAt']) ??
          DateTime.parse(json['updatedAt'] as String).toLocal(),
      lastRunId: json['lastRunId'] as String?,
      lastPrompt: json['lastPrompt'] as String?,
    );
  }

  final String id;
  final String workspaceId;
  final String? model;
  final String? providerSessionId;
  final String? geminiSessionId;
  final String? transcriptPath;
  final String status;
  final String lastMessageStatus;
  final DateTime createdAt;
  final DateTime updatedAt;
  final DateTime lastActivityAt;
  final String? lastRunId;
  final String? lastPrompt;

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'workspaceId': workspaceId,
      'model': model,
      'providerSessionId': providerSessionId,
      'geminiSessionId': geminiSessionId,
      'transcriptPath': transcriptPath,
      'status': status,
      'lastMessageStatus': lastMessageStatus,
      'createdAt': createdAt.toUtc().toIso8601String(),
      'updatedAt': updatedAt.toUtc().toIso8601String(),
      'lastActivityAt': lastActivityAt.toUtc().toIso8601String(),
      'lastRunId': lastRunId,
      'lastPrompt': lastPrompt,
    };
  }
}

class RunRecord {
  const RunRecord({
    required this.id,
    required this.sessionId,
    required this.model,
    required this.status,
    required this.prompt,
    required this.startedAt,
    required this.endedAt,
    required this.exitCode,
    required this.cancelledByUser,
    required this.stdoutTail,
    required this.stderrTail,
  });

  factory RunRecord.fromJson(Map<String, dynamic> json) {
    return RunRecord(
      id: json['id'] as String,
      sessionId: json['sessionId'] as String,
      model: json['model'] as String?,
      status: json['status'] as String,
      prompt: json['prompt'] as String? ?? '',
      startedAt: _parseDateTime(json['startedAt']) ?? DateTime.now(),
      endedAt: _parseDateTime(json['endedAt']),
      exitCode: json['exitCode'] as int?,
      cancelledByUser: json['cancelledByUser'] as bool? ?? false,
      stdoutTail: json['stdoutTail'] as String?,
      stderrTail: json['stderrTail'] as String?,
    );
  }

  final String id;
  final String sessionId;
  final String? model;
  final String status;
  final String prompt;
  final DateTime startedAt;
  final DateTime? endedAt;
  final int? exitCode;
  final bool cancelledByUser;
  final String? stdoutTail;
  final String? stderrTail;

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'sessionId': sessionId,
      'model': model,
      'status': status,
      'prompt': prompt,
      'startedAt': startedAt.toUtc().toIso8601String(),
      'endedAt': endedAt?.toUtc().toIso8601String(),
      'exitCode': exitCode,
      'cancelledByUser': cancelledByUser,
      'stdoutTail': stdoutTail,
      'stderrTail': stderrTail,
    };
  }
}

class SessionEvent {
  const SessionEvent({
    required this.sessionId,
    required this.runId,
    required this.seq,
    required this.type,
    required this.ts,
    required this.payload,
  });

  factory SessionEvent.fromJson(Map<String, dynamic> json) {
    return SessionEvent(
      sessionId: json['sessionId'] as String,
      runId: json['runId'] as String?,
      seq: json['seq'] as int,
      type: json['type'] as String,
      ts: DateTime.parse(json['ts'] as String).toLocal(),
      payload: Map<String, dynamic>.from(json['payload'] as Map),
    );
  }

  final String sessionId;
  final String? runId;
  final int seq;
  final String type;
  final DateTime ts;
  final Map<String, dynamic> payload;

  Map<String, dynamic> toJson() {
    return {
      'sessionId': sessionId,
      'runId': runId,
      'seq': seq,
      'type': type,
      'ts': ts.toUtc().toIso8601String(),
      'payload': payload,
    };
  }
}

class SessionExport {
  const SessionExport({
    required this.exportedAt,
    required this.workspace,
    required this.session,
    required this.runs,
    required this.events,
  });

  factory SessionExport.fromJson(Map<String, dynamic> json) {
    return SessionExport(
      exportedAt: _parseDateTime(json['exportedAt']) ?? DateTime.now(),
      workspace: Workspace.fromJson(
        Map<String, dynamic>.from(json['workspace'] as Map),
      ),
      session: RemoteSession.fromJson(
        Map<String, dynamic>.from(json['session'] as Map),
      ),
      runs: (json['runs'] as List<dynamic>? ?? const [])
          .map(
            (item) =>
                RunRecord.fromJson(Map<String, dynamic>.from(item as Map)),
          )
          .toList(),
      events: (json['events'] as List<dynamic>? ?? const [])
          .map(
            (item) =>
                SessionEvent.fromJson(Map<String, dynamic>.from(item as Map)),
          )
          .toList(),
    );
  }

  final DateTime exportedAt;
  final Workspace workspace;
  final RemoteSession session;
  final List<RunRecord> runs;
  final List<SessionEvent> events;

  Map<String, dynamic> toJson() {
    return {
      'exportedAt': exportedAt.toUtc().toIso8601String(),
      'workspace': workspace.toJson(),
      'session': session.toJson(),
      'runs': runs.map((run) => run.toJson()).toList(),
      'events': events.map((event) => event.toJson()).toList(),
    };
  }
}

class RealtimeEnvelope {
  const RealtimeEnvelope({
    required this.sessionId,
    required this.workspaceId,
    required this.event,
  });

  factory RealtimeEnvelope.fromJson(Map<String, dynamic> json) {
    return RealtimeEnvelope(
      sessionId: json['sessionId'] as String,
      workspaceId: json['workspaceId'] as String,
      event: SessionEvent.fromJson(
        Map<String, dynamic>.from(json['event'] as Map),
      ),
    );
  }

  final String sessionId;
  final String workspaceId;
  final SessionEvent event;
}

String providerDisplayName(String provider) {
  switch (provider) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'gemini':
    default:
      return 'Gemini';
  }
}

String providerSessionLabel(String provider) {
  switch (provider) {
    case 'claude':
      return 'Session id';
    case 'codex':
      return 'Thread id';
    case 'gemini':
    default:
      return 'Session id';
  }
}

String modelDisplayLabel(String? model) {
  final trimmed = model?.trim();
  if (trimmed == null || trimmed.isEmpty) {
    return 'Default';
  }

  return trimmed;
}

String providerModelHelperText(String provider) {
  return 'Choose a preset, or switch to Custom to enter any ${providerDisplayName(provider)} model id supported by your local CLI.';
}

List<ProviderModelOption> providerModelOptions(String provider) {
  switch (provider) {
    case 'claude':
      return const [
        ProviderModelOption(value: 'sonnet', label: 'Sonnet (Latest)'),
        ProviderModelOption(
          value: 'claude-sonnet-4-6',
          label: 'Claude Sonnet 4.6',
        ),
        ProviderModelOption(value: 'opus', label: 'Opus (Latest)'),
        ProviderModelOption(
          value: 'claude-opus-4-6',
          label: 'Claude Opus 4.6',
        ),
        ProviderModelOption(value: 'haiku', label: 'Haiku'),
        ProviderModelOption(value: 'best', label: 'Best Available'),
        ProviderModelOption(value: 'opusplan', label: 'Opus Plan'),
      ];
    case 'codex':
      return const [
        ProviderModelOption(
          value: 'gpt-5.5',
          label: 'GPT-5.5',
        ),
        ProviderModelOption(value: 'gpt-5.4', label: 'GPT-5.4'),
        ProviderModelOption(value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini'),
        ProviderModelOption(value: 'gpt-5.3-codex', label: 'GPT-5.3-Codex'),
        ProviderModelOption(
          value: 'gpt-5.1-codex-max',
          label: 'GPT-5.1 Codex Max',
        ),
        ProviderModelOption(value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex'),
        ProviderModelOption(
          value: 'gpt-5.1-codex-mini',
          label: 'GPT-5.1 Codex Mini',
        ),
        ProviderModelOption(
          value: 'gpt-5-codex',
          label: 'GPT-5 Codex (Legacy)',
        ),
      ];
    case 'gemini':
    default:
      return const [
        ProviderModelOption(
          value: 'gemini-3.1-pro-preview',
          label: 'Gemini 3.1 Pro Preview',
        ),
        ProviderModelOption(
          value: 'gemini-3.1-pro-preview-customtools',
          label: 'Gemini 3.1 Pro Preview Custom Tools',
        ),
        ProviderModelOption(
          value: 'gemini-3-flash-preview',
          label: 'Gemini 3 Flash Preview',
        ),
        ProviderModelOption(
          value: 'gemini-3.1-flash-lite-preview',
          label: 'Gemini 3.1 Flash-Lite Preview',
        ),
        ProviderModelOption(value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro'),
        ProviderModelOption(
          value: 'gemini-2.5-flash',
          label: 'Gemini 2.5 Flash',
        ),
        ProviderModelOption(
          value: 'gemini-2.5-flash-lite',
          label: 'Gemini 2.5 Flash-Lite',
        ),
        ProviderModelOption(
          value: 'gemini-2.0-flash',
          label: 'Gemini 2.0 Flash (Legacy)',
        ),
        ProviderModelOption(
          value: 'gemini-2.0-flash-lite',
          label: 'Gemini 2.0 Flash-Lite (Legacy)',
        ),
      ];
  }
}

bool isKnownProviderModel(String provider, String model) {
  return providerModelOptions(
    provider,
  ).any((option) => option.value == model.trim());
}

String messageStatusLabel(String status) {
  switch (status) {
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'idle':
    default:
      return 'Idle';
  }
}

DateTime? _parseDateTime(Object? value) {
  if (value == null) {
    return null;
  }

  return DateTime.parse(value as String).toLocal();
}
