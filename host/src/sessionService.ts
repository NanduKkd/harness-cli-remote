import { randomUUID } from 'node:crypto';

import type { FastifyBaseLogger } from 'fastify';

import { AppDatabase } from './db.js';
import { CodexRunner } from './codexRunner.js';
import { GeminiRunner } from './geminiRunner.js';
import type { RunnerControls, RuntimeRun, WorkspaceRunner } from './runners.js';
import type {
  BroadcastEnvelope,
  HookIngressBody,
  RunRecord,
  SessionEventRecord,
  SessionRecord,
  WorkspaceConfig,
  WorkspaceProvider,
} from './types.js';
import { clampText, nowIso } from './util.js';

type BroadcastFn = (envelope: BroadcastEnvelope) => void;

export class SessionService {
  private readonly runtimesBySession = new Map<string, RuntimeRun>();
  private readonly runtimesByHookToken = new Map<string, RuntimeRun>();
  private readonly runners = new Map<WorkspaceProvider, WorkspaceRunner>([
    ['gemini', new GeminiRunner()],
    ['codex', new CodexRunner()],
  ]);
  private readonly controls: RunnerControls;

  constructor(
    private readonly database: AppDatabase,
    private readonly workspaces: Map<string, WorkspaceConfig>,
    private readonly daemonUrl: string,
    private readonly logger: FastifyBaseLogger,
    private readonly broadcast: BroadcastFn,
  ) {
    this.controls = {
      emit: (sessionId, runId, event) => this.emit(sessionId, runId, event),
      updateSessionMetadata: (sessionId, input) =>
        this.database.updateSessionMetadata(sessionId, input),
      getSession: (sessionId) => this.database.getSession(sessionId),
      getRun: (runId) => this.database.getRun(runId),
      getLatestCompletedMessage: (runId) =>
        this.database.getLatestCompletedMessage(runId),
      logger: this.logger,
    };
  }

  createSession(workspaceId: string, prompt: string): SessionRecord {
    const workspace = this.requireWorkspace(workspaceId);
    const session = this.database.createSession(randomUUID(), workspace.id);
    this.startRun(session, workspace, prompt, false);
    return this.database.getSessionOrThrow(session.id);
  }

  sendPrompt(sessionId: string, prompt: string): SessionRecord {
    const session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);

    if (this.runtimesBySession.has(session.id)) {
      throw new Error('Session already has an active run.');
    }

    if (!session.providerSessionId) {
      throw new Error('Session is missing provider session metadata.');
    }

    this.startRun(session, workspace, prompt, true);
    return this.database.getSessionOrThrow(session.id);
  }

  cancelSession(sessionId: string): boolean {
    const runtime = this.runtimesBySession.get(sessionId);
    if (!runtime) {
      return false;
    }

    this.database.markRunCancelRequested(runtime.runId);
    runtime.child.kill('SIGINT');
    runtime.cancelTimer = setTimeout(() => {
      runtime.child.kill('SIGKILL');
    }, 3000);

    return true;
  }

  handleHookIngress(token: string, body: HookIngressBody): SessionEventRecord[] {
    const runtime = this.runtimesByHookToken.get(token);
    if (!runtime) {
      throw new Error('Unknown hook token.');
    }

    if (
      runtime.sessionId !== body.remoteSessionId ||
      runtime.runId !== body.remoteRunId
    ) {
      throw new Error('Hook payload does not match active run.');
    }

    return runtime.runner.handleHookIngress?.(runtime, body, this.controls) ?? [];
  }

  private startRun(
    session: SessionRecord,
    workspace: WorkspaceConfig,
    prompt: string,
    resume: boolean,
  ): void {
    const run = this.database.createRun(randomUUID(), session.id, prompt);
    const hookToken = randomUUID();
    const runner = this.requireRunner(workspace.provider);
    const { child, state } = runner.spawnRun({
      session,
      workspace,
      prompt,
      resume,
      daemonUrl: this.daemonUrl,
      hookToken,
      runId: run.id,
      logger: this.logger,
    });

    const runtime: RuntimeRun = {
      child,
      runId: run.id,
      sessionId: session.id,
      workspace,
      hookToken,
      stdoutTail: '',
      stderrTail: '',
      cancelTimer: null,
      runner,
      state,
    };

    this.runtimesBySession.set(session.id, runtime);
    this.runtimesByHookToken.set(hookToken, runtime);

    // Prompts are passed as CLI arguments; close stdin so providers do not
    // wait for additional interactive input from the host process.
    child.stdin.end();

    this.emit(session.id, run.id, {
      type: 'run.started',
      payload: {
        prompt,
        resume,
        workspaceId: workspace.id,
        provider: workspace.provider,
      },
      ts: run.startedAt,
    });

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      runtime.stdoutTail = clampText(`${runtime.stdoutTail}${text}`, 4000);
      runtime.runner.handleStdoutChunk?.(runtime, text, this.controls);
    });

    child.stderr.on('data', (chunk) => {
      runtime.stderrTail = clampText(
        `${runtime.stderrTail}${chunk.toString()}`,
        4000,
      );
    });

    child.on('error', (error) => {
      runtime.stderrTail = clampText(
        `${runtime.stderrTail}\n${error.message}`,
        4000,
      );
    });

    child.on('exit', (code, signal) => {
      if (runtime.cancelTimer) {
        clearTimeout(runtime.cancelTimer);
      }

      this.finalizeRun(runtime, run, code, signal);
    });
  }

  private finalizeRun(
    runtime: RuntimeRun,
    run: RunRecord,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.runtimesBySession.delete(runtime.sessionId);
    this.runtimesByHookToken.delete(runtime.hookToken);

    let stdoutTail = runtime.stdoutTail;
    let stderrTail = runtime.stderrTail;

    const latestRun = this.database.getRunOrThrow(run.id);
    const cancelled =
      latestRun.cancelledByUser || signal === 'SIGINT' || signal === 'SIGKILL';
    let status: RunRecord['status'] =
      cancelled ? 'cancelled' : code === 0 ? 'completed' : 'failed';

    const finalization = runtime.runner.finalize?.(
      runtime,
      run,
      code,
      signal,
      this.controls,
    );

    if (finalization?.stdoutTail !== undefined) {
      stdoutTail = finalization.stdoutTail;
    }
    if (finalization?.stderrTail !== undefined) {
      stderrTail = finalization.stderrTail;
    }
    if (finalization?.status) {
      status = finalization.status;
    }

    const finishedRun = this.database.finishRun(run.id, {
      status,
      exitCode: code,
      stdoutTail,
      stderrTail,
    });

    const eventType =
      finishedRun.status === 'cancelled'
        ? 'run.cancelled'
        : finishedRun.status === 'failed'
          ? 'run.failed'
          : 'run.completed';

    this.emit(runtime.sessionId, run.id, {
      type: eventType,
      payload: {
        exitCode: code,
        signal,
        stdoutTail,
        stderrTail,
      },
      ts: nowIso(),
    });
  }

  private emit(
    sessionId: string,
    runId: string | null,
    event: {
      type: string;
      payload: Record<string, unknown>;
      ts: string;
    },
  ): SessionEventRecord {
    const inserted = this.database.insertEvent(
      sessionId,
      runId,
      event.type,
      event.payload,
      event.ts,
    );
    const session = this.database.getSessionOrThrow(sessionId);
    this.broadcast({
      type: 'session.event',
      sessionId,
      workspaceId: session.workspaceId,
      event: inserted,
    });
    return inserted;
  }

  private requireRunner(provider: WorkspaceProvider): WorkspaceRunner {
    const runner = this.runners.get(provider);
    if (!runner) {
      throw new Error(`Unsupported workspace provider: ${provider}`);
    }
    return runner;
  }

  private requireWorkspace(id: string): WorkspaceConfig {
    const workspace = this.workspaces.get(id);
    if (!workspace) {
      throw new Error(`Unknown workspace: ${id}`);
    }
    return workspace;
  }

  private requireSession(id: string): SessionRecord {
    const session = this.database.getSession(id);
    if (!session) {
      throw new Error(`Unknown session: ${id}`);
    }
    return session;
  }
}
