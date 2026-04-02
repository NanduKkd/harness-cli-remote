export type HookStatus = 'installed' | 'missing';
export type SessionStatus = 'idle' | 'running' | 'failed' | 'cancelled';
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkspaceConfig {
  id: string;
  name: string;
  rootPath: string;
}

export interface ResolvedConfig {
  server: {
    host: string;
    port: number;
    databasePath: string;
  };
  workspaces: WorkspaceConfig[];
  configPath: string;
}

export interface WorkspaceRecord extends WorkspaceConfig {
  hookStatus: HookStatus;
}

export interface SessionRecord {
  id: string;
  workspaceId: string;
  geminiSessionId: string | null;
  transcriptPath: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  lastRunId: string | null;
}

export interface RunRecord {
  id: string;
  sessionId: string;
  status: RunStatus;
  prompt: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  cancelledByUser: boolean;
  stdoutTail: string;
  stderrTail: string;
}

export interface SessionEventRecord {
  sessionId: string;
  runId: string | null;
  seq: number;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}

export interface HookIngressBody {
  remoteSessionId: string;
  remoteRunId: string;
  hookPayload: Record<string, unknown>;
  receivedAt: string;
}

export interface BroadcastEnvelope {
  type: 'session.event';
  sessionId: string;
  workspaceId: string;
  event: SessionEventRecord;
}
