enum ConnectionStatus { disconnected, connecting, connected }

class AuthSession {
  const AuthSession({required this.baseUrl, required this.token});

  final String baseUrl;
  final String token;

  Uri get httpUri => Uri.parse(baseUrl);

  Uri get websocketUri {
    final http = httpUri;
    return http.replace(
      scheme: http.scheme == 'https' ? 'wss' : 'ws',
      path: '/ws',
      queryParameters: {'token': token},
    );
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

class RemoteSession {
  const RemoteSession({
    required this.id,
    required this.workspaceId,
    required this.providerSessionId,
    required this.geminiSessionId,
    required this.transcriptPath,
    required this.status,
    required this.lastMessageStatus,
    required this.createdAt,
    required this.updatedAt,
    required this.lastActivityAt,
    required this.lastRunId,
  });

  factory RemoteSession.fromJson(Map<String, dynamic> json) {
    return RemoteSession(
      id: json['id'] as String,
      workspaceId: json['workspaceId'] as String,
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
    );
  }

  final String id;
  final String workspaceId;
  final String? providerSessionId;
  final String? geminiSessionId;
  final String? transcriptPath;
  final String status;
  final String lastMessageStatus;
  final DateTime createdAt;
  final DateTime updatedAt;
  final DateTime lastActivityAt;
  final String? lastRunId;

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'workspaceId': workspaceId,
      'providerSessionId': providerSessionId,
      'geminiSessionId': geminiSessionId,
      'transcriptPath': transcriptPath,
      'status': status,
      'lastMessageStatus': lastMessageStatus,
      'createdAt': createdAt.toUtc().toIso8601String(),
      'updatedAt': updatedAt.toUtc().toIso8601String(),
      'lastActivityAt': lastActivityAt.toUtc().toIso8601String(),
      'lastRunId': lastRunId,
    };
  }
}

class RunRecord {
  const RunRecord({
    required this.id,
    required this.sessionId,
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
    case 'codex':
      return 'Codex';
    case 'gemini':
    default:
      return 'Gemini';
  }
}

String providerSessionLabel(String provider) {
  switch (provider) {
    case 'codex':
      return 'Thread id';
    case 'gemini':
    default:
      return 'Session id';
  }
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
