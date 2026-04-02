enum ConnectionStatus {
  disconnected,
  connecting,
  connected,
}

class AuthSession {
  const AuthSession({
    required this.baseUrl,
    required this.token,
  });

  final String baseUrl;
  final String token;

  Uri get httpUri => Uri.parse(baseUrl);

  Uri get websocketUri {
    final http = httpUri;
    return http.replace(
      scheme: http.scheme == 'https' ? 'wss' : 'ws',
      path: '/ws',
      queryParameters: {
        'token': token,
      },
    );
  }
}

class Workspace {
  const Workspace({
    required this.id,
    required this.name,
    required this.rootPath,
    required this.hookStatus,
  });

  factory Workspace.fromJson(Map<String, dynamic> json) {
    return Workspace(
      id: json['id'] as String,
      name: json['name'] as String,
      rootPath: json['rootPath'] as String,
      hookStatus: json['hookStatus'] as String? ?? 'missing',
    );
  }

  final String id;
  final String name;
  final String rootPath;
  final String hookStatus;
}

class RemoteSession {
  const RemoteSession({
    required this.id,
    required this.workspaceId,
    required this.geminiSessionId,
    required this.transcriptPath,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    required this.lastRunId,
  });

  factory RemoteSession.fromJson(Map<String, dynamic> json) {
    return RemoteSession(
      id: json['id'] as String,
      workspaceId: json['workspaceId'] as String,
      geminiSessionId: json['geminiSessionId'] as String?,
      transcriptPath: json['transcriptPath'] as String?,
      status: json['status'] as String,
      createdAt: DateTime.parse(json['createdAt'] as String).toLocal(),
      updatedAt: DateTime.parse(json['updatedAt'] as String).toLocal(),
      lastRunId: json['lastRunId'] as String?,
    );
  }

  final String id;
  final String workspaceId;
  final String? geminiSessionId;
  final String? transcriptPath;
  final String status;
  final DateTime createdAt;
  final DateTime updatedAt;
  final String? lastRunId;
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
