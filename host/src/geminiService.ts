import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { FastifyBaseLogger } from 'fastify';

import { AppDatabase } from './db.js';
import type {
  BroadcastEnvelope,
  HookIngressBody,
  RunRecord,
  SessionEventRecord,
  SessionRecord,
  WorkspaceConfig,
} from './types.js';
import { clampText, extractAfterModelText, nowIso, summarizeJson } from './util.js';

type RuntimeRun = {
  child: ChildProcessWithoutNullStreams;
  runId: string;
  sessionId: string;
  workspace: WorkspaceConfig;
  hookToken: string;
  lastStreamText: string;
  stdoutTail: string;
  stderrTail: string;
  cancelTimer: NodeJS.Timeout | null;
};

type BroadcastFn = (envelope: BroadcastEnvelope) => void;

export class GeminiService {
  private readonly runtimesBySession = new Map<string, RuntimeRun>();
  private readonly runtimesByHookToken = new Map<string, RuntimeRun>();

  constructor(
    private readonly database: AppDatabase,
    private readonly workspaces: Map<string, WorkspaceConfig>,
    private readonly daemonUrl: string,
    private readonly logger: FastifyBaseLogger,
    private readonly broadcast: BroadcastFn,
  ) {}

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

    if (!session.geminiSessionId) {
      throw new Error('Session is missing Gemini session metadata.');
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

    const hookPayload = body.hookPayload;
    const hookEventName = String(hookPayload.hook_event_name ?? '');
    const events: SessionEventRecord[] = [];

    switch (hookEventName) {
      case 'SessionStart': {
        const geminiSessionId = stringOrNull(hookPayload.session_id);
        const transcriptPath = stringOrNull(hookPayload.transcript_path);
        this.database.updateSessionMetadata(runtime.sessionId, {
          geminiSessionId,
          transcriptPath,
          status: 'running',
        });
        events.push(
          this.emit(runtime.sessionId, runtime.runId, {
            type: 'session.started',
            payload: {
              source: hookPayload.source ?? null,
              geminiSessionId,
              transcriptPath,
            },
            ts: body.receivedAt,
          }),
        );
        break;
      }
      case 'AfterModel': {
        const fullText = extractAfterModelText(hookPayload.llm_response);
        if (!fullText) {
          break;
        }

        const delta = fullText.startsWith(runtime.lastStreamText)
          ? fullText.slice(runtime.lastStreamText.length)
          : fullText;
        runtime.lastStreamText = fullText;
        if (!delta) {
          break;
        }

        events.push(
          this.emit(runtime.sessionId, runtime.runId, {
            type: 'message.delta',
            payload: {
              text: delta,
              fullText,
            },
            ts: body.receivedAt,
          }),
        );
        break;
      }
      case 'BeforeTool': {
        events.push(
          this.emit(runtime.sessionId, runtime.runId, {
            type: 'tool.started',
            payload: {
              toolName: hookPayload.tool_name ?? null,
              toolInput: hookPayload.tool_input ?? null,
              toolInputSummary: summarizeJson(hookPayload.tool_input),
            },
            ts: body.receivedAt,
          }),
        );
        break;
      }
      case 'AfterTool': {
        const toolResponse = hookPayload.tool_response;
        const responseObject =
          toolResponse && typeof toolResponse === 'object'
            ? (toolResponse as Record<string, unknown>)
            : {};
        events.push(
          this.emit(runtime.sessionId, runtime.runId, {
            type: 'tool.completed',
            payload: {
              toolName: hookPayload.tool_name ?? null,
              toolInput: hookPayload.tool_input ?? null,
              toolResponse,
              success: !responseObject.error,
              toolInputSummary: summarizeJson(hookPayload.tool_input),
              toolResponseSummary: summarizeJson(toolResponse),
            },
            ts: body.receivedAt,
          }),
        );
        break;
      }
      case 'AfterAgent': {
        const text = String(hookPayload.prompt_response ?? '');
        runtime.lastStreamText = text || runtime.lastStreamText;
        events.push(
          this.emit(runtime.sessionId, runtime.runId, {
            type: 'message.completed',
            payload: {
              text,
              prompt: hookPayload.prompt ?? null,
              stopHookActive: hookPayload.stop_hook_active ?? false,
            },
            ts: body.receivedAt,
          }),
        );
        break;
      }
      case 'Notification': {
        events.push(
          this.emit(runtime.sessionId, runtime.runId, {
            type: 'notification',
            payload: {
              notificationType: hookPayload.notification_type ?? null,
              message: hookPayload.message ?? null,
              details: hookPayload.details ?? null,
            },
            ts: body.receivedAt,
          }),
        );
        break;
      }
      case 'SessionEnd': {
        events.push(
          this.emit(runtime.sessionId, runtime.runId, {
            type: 'session.ended',
            payload: {
              reason: hookPayload.reason ?? null,
            },
            ts: body.receivedAt,
          }),
        );
        break;
      }
      default:
        this.logger.debug({ hookEventName }, 'Ignoring unsupported hook event');
    }

    return events;
  }

  private startRun(
    session: SessionRecord,
    workspace: WorkspaceConfig,
    prompt: string,
    resume: boolean,
  ): void {
    const run = this.database.createRun(randomUUID(), session.id, prompt);
    const hookToken = randomUUID();
    const args = ['--yolo'];
    if (resume) {
      args.push('--resume', session.geminiSessionId ?? '');
    }
    args.push('-p', prompt);

    const child = spawn('gemini', args, {
      cwd: workspace.rootPath,
      env: {
        ...process.env,
        REMOTE_DAEMON_URL: this.daemonUrl,
        REMOTE_HOOK_TOKEN: hookToken,
        REMOTE_SESSION_ID: session.id,
        REMOTE_RUN_ID: run.id,
      },
    });

    const runtime: RuntimeRun = {
      child,
      runId: run.id,
      sessionId: session.id,
      workspace,
      hookToken,
      lastStreamText: '',
      stdoutTail: '',
      stderrTail: '',
      cancelTimer: null,
    };

    this.runtimesBySession.set(session.id, runtime);
    this.runtimesByHookToken.set(hookToken, runtime);

    this.emit(session.id, run.id, {
      type: 'run.started',
      payload: {
        prompt,
        resume,
        workspaceId: workspace.id,
      },
      ts: run.startedAt,
    });

    child.stdout.on('data', (chunk) => {
      runtime.stdoutTail = clampText(
        `${runtime.stdoutTail}${chunk.toString()}`,
        4000,
      );
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

    this.reconcileTranscript(run.id);
    const latestRun = this.database.getRunOrThrow(run.id);
    const cancelled =
      latestRun.cancelledByUser || signal === 'SIGINT' || signal === 'SIGKILL';
    const status: RunRecord['status'] =
      cancelled ? 'cancelled' : code === 0 ? 'completed' : 'failed';
    const finishedRun = this.database.finishRun(run.id, {
      status,
      exitCode: code,
      stdoutTail: runtime.stdoutTail,
      stderrTail: runtime.stderrTail,
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
        stdoutTail: runtime.stdoutTail,
        stderrTail: runtime.stderrTail,
      },
      ts: nowIso(),
    });
  }

  private reconcileTranscript(runId: string): void {
    const run = this.database.getRun(runId);
    if (!run) {
      return;
    }

    const session = this.database.getSession(run.sessionId);
    if (!session?.transcriptPath) {
      return;
    }

    try {
      const transcript = JSON.parse(readFileSync(session.transcriptPath, 'utf8')) as {
        sessionId?: string;
        messages?: Array<{
          timestamp?: string;
          type?: string;
          content?: unknown;
        }>;
      };

      this.database.updateSessionMetadata(session.id, {
        geminiSessionId: transcript.sessionId ?? session.geminiSessionId,
        transcriptPath: session.transcriptPath,
      });

      const latestMessage = [...(transcript.messages ?? [])]
        .reverse()
        .find(
          (message) =>
            message.type === 'gemini' &&
            typeof message.content === 'string' &&
            (!message.timestamp || message.timestamp >= run.startedAt),
        );

      if (!latestMessage || typeof latestMessage.content !== 'string') {
        return;
      }

      const existing = this.database.getLatestCompletedMessage(run.id);
      if (
        normalizeMessageText(existing?.payload.text as string | undefined) ===
        normalizeMessageText(latestMessage.content)
      ) {
        return;
      }

      this.emit(session.id, run.id, {
        type: 'message.completed',
        payload: {
          text: latestMessage.content,
          source: 'transcript-reconcile',
        },
        ts: latestMessage.timestamp ?? nowIso(),
      });
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          runId,
          transcriptPath: session.transcriptPath,
        },
        'Failed to reconcile transcript',
      );
    }
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

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeMessageText(value: string | undefined): string {
  return (value ?? '').replaceAll(/\s+/g, ' ').trim();
}
