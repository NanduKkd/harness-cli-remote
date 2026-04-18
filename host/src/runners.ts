import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { FastifyBaseLogger } from 'fastify';

import type {
  HookIngressBody,
  RunRecord,
  RunStatus,
  SessionEventRecord,
  SessionRecord,
  SessionStatus,
  WorkspaceConfig,
  WorkspaceProvider,
} from './types.js';

export interface RuntimeRun {
  child: ChildProcessWithoutNullStreams;
  runId: string;
  sessionId: string;
  workspace: WorkspaceConfig;
  hookToken: string;
  stdoutTail: string;
  stderrTail: string;
  cancelTimer: NodeJS.Timeout | null;
  cancelRequestedByUser: boolean;
  sendSignal: (signal: NodeJS.Signals) => void;
  runner: WorkspaceRunner;
  state: unknown;
}

export interface SpawnRunArgs {
  session: SessionRecord;
  workspace: WorkspaceConfig;
  model: string | null;
  prompt: string;
  resume: boolean;
  daemonUrl: string;
  hookToken: string;
  runId: string;
  logger: FastifyBaseLogger;
}

export interface RunnerControls {
  emit(
    sessionId: string,
    runId: string | null,
    event: {
      type: string;
      payload: Record<string, unknown>;
      ts: string;
    },
  ): SessionEventRecord;
  updateSessionMetadata(
    sessionId: string,
    input: {
      model?: string | null;
      providerSessionId?: string | null;
      geminiSessionId?: string | null;
      transcriptPath?: string | null;
      status?: SessionStatus;
    },
  ): SessionRecord;
  getSession(sessionId: string): SessionRecord | null;
  getRun(runId: string): RunRecord | null;
  getLatestCompletedMessage(runId: string): SessionEventRecord | null;
  logger: FastifyBaseLogger;
}

export interface RunnerFinalizationResult {
  status?: RunStatus;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface WorkspaceRunner {
  readonly provider: WorkspaceProvider;
  spawnRun(args: SpawnRunArgs): {
    child: ChildProcessWithoutNullStreams;
    state: unknown;
    sendSignal?: (signal: NodeJS.Signals) => void;
  };
  handleStdoutChunk?(
    runtime: RuntimeRun,
    chunk: string,
    controls: RunnerControls,
  ): void;
  handleHookIngress?(
    runtime: RuntimeRun,
    body: HookIngressBody,
    controls: RunnerControls,
  ): SessionEventRecord[];
  finalize?(
    runtime: RuntimeRun,
    run: RunRecord,
    code: number | null,
    signal: NodeJS.Signals | null,
    controls: RunnerControls,
  ): RunnerFinalizationResult | void;
}
