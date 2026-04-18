import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

import type { RunRecord, SessionEventRecord } from './types.js';
import type { RunnerControls, RuntimeRun, SpawnRunArgs, WorkspaceRunner } from './runners.js';
import { nowIso, summarizeJson } from './util.js';

type GeminiRuntimeState = {
  fallbackMessageText: string | null;
};

type GeminiTranscript = {
  sessionId?: string;
  messages?: Array<{
    timestamp?: string;
    type?: string;
    content?: unknown;
  }>;
};

type GeminiTranscriptSnapshot = {
  transcriptPath: string;
  transcript: GeminiTranscript;
  sessionId: string | null;
};

export class GeminiRunner implements WorkspaceRunner {
  readonly provider = 'gemini' as const;

  spawnRun(args: SpawnRunArgs) {
    const { session, workspace, model, prompt, resume, daemonUrl, hookToken, runId } = args;
    const useProcessGroupSignals = process.platform !== 'win32';
    const child = spawn(
      process.env.GEMINI_BIN ?? 'gemini',
      buildGeminiArgs(session, prompt, resume, model),
      {
        cwd: workspace.rootPath,
        detached: useProcessGroupSignals,
        env: {
          ...process.env,
          REMOTE_DAEMON_URL: daemonUrl,
          REMOTE_HOOK_TOKEN: hookToken,
          REMOTE_SESSION_ID: session.id,
          REMOTE_RUN_ID: runId,
          REMOTE_WORKSPACE_ROOT: workspace.rootPath,
        },
      },
    );

    return {
      child,
      sendSignal: (signal: NodeJS.Signals) =>
        sendGeminiSignal(child, signal, useProcessGroupSignals),
      state: {
        fallbackMessageText: null,
      } satisfies GeminiRuntimeState,
    };
  }

  handleHookIngress(
    runtime: RuntimeRun,
    body: {
      hookPayload: Record<string, unknown>;
      receivedAt: string;
    },
    controls: RunnerControls,
  ): SessionEventRecord[] {
    const state = runtime.state as GeminiRuntimeState;
    const hookPayload = body.hookPayload;
    const hookEventName = String(hookPayload.hook_event_name ?? '');
    const events: SessionEventRecord[] = [];

    switch (hookEventName) {
      case 'SessionStart': {
        const geminiSessionId = stringOrNull(hookPayload.session_id);
        const session = controls.getSession(runtime.sessionId);
        const transcriptPath = resolveTranscriptPath({
          reportedPath: stringOrNull(hookPayload.transcript_path),
          existingPath: session?.transcriptPath ?? null,
          sessionId:
            geminiSessionId ??
            session?.providerSessionId ??
            session?.geminiSessionId ??
            null,
        });
        controls.updateSessionMetadata(runtime.sessionId, {
          providerSessionId: geminiSessionId,
          geminiSessionId,
          transcriptPath,
          status: 'running',
        });
        events.push(
          controls.emit(runtime.sessionId, runtime.runId, {
            type: 'session.started',
            payload: {
              source: hookPayload.source ?? null,
              providerSessionId: geminiSessionId,
              geminiSessionId,
              transcriptPath,
            },
            ts: body.receivedAt,
          }),
        );
        break;
      }
      case 'AfterModel':
        // Gemini's AfterModel payload can include internal thought text and
        // non-monotonic chunks. Final transcript/stdout reconciliation is more
        // reliable than attempting to stream these raw payloads.
        break;
      case 'BeforeTool': {
        events.push(
          controls.emit(runtime.sessionId, runtime.runId, {
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
          controls.emit(runtime.sessionId, runtime.runId, {
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
        state.fallbackMessageText = stringOrNull(hookPayload.prompt_response);
        break;
      }
      case 'Notification': {
        events.push(
          controls.emit(runtime.sessionId, runtime.runId, {
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
          controls.emit(runtime.sessionId, runtime.runId, {
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
        controls.logger.debug({ hookEventName }, 'Ignoring unsupported Gemini hook event');
    }

    return events;
  }

  finalize(
    runtime: RuntimeRun,
    run: RunRecord,
    _code: number | null,
    _signal: NodeJS.Signals | null,
    controls: RunnerControls,
  ) {
    reconcileTranscript(runtime.runId, controls);
    const existing = controls.getLatestCompletedMessage(run.id);
    if (existing) {
      return undefined;
    }

    const state = runtime.state as GeminiRuntimeState;
    const fallbackText =
      extractGeminiStdoutText(runtime.stdoutTail) ?? state.fallbackMessageText;
    if (!fallbackText) {
      return undefined;
    }

    controls.emit(runtime.sessionId, run.id, {
      type: 'message.completed',
      payload: {
        text: fallbackText,
        source: 'gemini-stdout-reconcile',
      },
      ts: nowIso(),
    });
    return undefined;
  }
}

export function buildGeminiArgs(
  session: { providerSessionId: string | null; geminiSessionId: string | null },
  prompt: string,
  resume: boolean,
  model: string | null,
): string[] {
  const args = ['--yolo'];
  if (model) {
    args.push('--model', model);
  }
  if (resume) {
    args.push('--resume', session.providerSessionId ?? session.geminiSessionId ?? '');
  }
  args.push('-p', prompt);
  return args;
}

function sendGeminiSignal(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
  useProcessGroupSignals: boolean,
): void {
  if (useProcessGroupSignals && child.pid != null) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (!isMissingProcessError(error)) {
        throw error;
      }
    }
  }

  try {
    child.kill(signal);
  } catch (error) {
    if (!isMissingProcessError(error)) {
      throw error;
    }
  }
}

function isMissingProcessError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
}

function reconcileTranscript(runId: string, controls: RunnerControls): void {
  const run = controls.getRun(runId);
  if (!run) {
    return;
  }

  const session = controls.getSession(run.sessionId);
  if (!session) {
    return;
  }

  const snapshot = loadGeminiTranscript(session, controls.logger);
  if (!snapshot) {
    return;
  }

  controls.updateSessionMetadata(session.id, {
    providerSessionId: snapshot.sessionId ?? session.providerSessionId,
    geminiSessionId: snapshot.sessionId ?? session.geminiSessionId,
    transcriptPath: snapshot.transcriptPath,
  });

  const latestMessage = [...(snapshot.transcript.messages ?? [])]
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

  const existing = controls.getLatestCompletedMessage(run.id);
  if (
    normalizeMessageText(existing?.payload.text as string | undefined) ===
    normalizeMessageText(latestMessage.content)
  ) {
    return;
  }

  controls.emit(session.id, run.id, {
    type: 'message.completed',
    payload: {
      text: latestMessage.content,
      source: 'transcript-reconcile',
    },
    ts: latestMessage.timestamp ?? nowIso(),
  });
}

export function recoverGeminiSessionMetadata(
  session: {
    providerSessionId: string | null;
    geminiSessionId: string | null;
    transcriptPath: string | null;
  },
  logger: Pick<FastifyBaseLogger, 'warn'>,
): {
  providerSessionId: string | null;
  geminiSessionId: string | null;
  transcriptPath: string | null;
} | null {
  const snapshot = loadGeminiTranscript(session, logger);
  if (!snapshot) {
    return null;
  }

  return {
    providerSessionId:
      snapshot.sessionId ?? session.providerSessionId ?? session.geminiSessionId,
    geminiSessionId: snapshot.sessionId ?? session.geminiSessionId,
    transcriptPath: snapshot.transcriptPath,
  };
}

function loadGeminiTranscript(
  session: {
    providerSessionId: string | null;
    geminiSessionId: string | null;
    transcriptPath: string | null;
  },
  logger: Pick<FastifyBaseLogger, 'warn'>,
): GeminiTranscriptSnapshot | null {
  const transcriptPath = resolveTranscriptPath({
    reportedPath: session.transcriptPath,
    existingPath: session.transcriptPath,
    sessionId: session.providerSessionId ?? session.geminiSessionId,
  });
  if (!transcriptPath) {
    return null;
  }

  try {
    const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8')) as GeminiTranscript;
    return {
      transcriptPath,
      transcript,
      sessionId: stringOrNull(transcript.sessionId),
    };
  } catch (error) {
    logger.warn(
      {
        err: error,
        transcriptPath,
      },
      'Failed to load Gemini transcript',
    );
    return null;
  }
}

function resolveTranscriptPath(input: {
  reportedPath: string | null;
  existingPath: string | null;
  sessionId: string | null;
}): string | null {
  const directCandidates = [input.reportedPath, input.existingPath].filter(
    (value): value is string => value != null && value.length > 0,
  );
  for (const candidate of directCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const sessionPrefix = input.sessionId?.slice(0, 8);
  if (!sessionPrefix) {
    return input.reportedPath ?? input.existingPath ?? null;
  }

  const directories = new Set<string>([
    path.join(os.homedir(), '.gemini', 'tmp', 'gemini-remote', 'chats'),
  ]);
  if (input.reportedPath) {
    directories.add(path.dirname(input.reportedPath));
  }
  if (input.existingPath) {
    directories.add(path.dirname(input.existingPath));
  }

  for (const directory of directories) {
    if (!existsSync(directory)) {
      continue;
    }

    const match = readdirSync(directory)
      .filter((entry) => entry.endsWith(`-${sessionPrefix}.json`))
      .sort()
      .at(-1);
    if (match) {
      return path.join(directory, match);
    }
  }

  return input.reportedPath ?? input.existingPath ?? null;
}

function extractGeminiStdoutText(stdoutTail: string): string | null {
  const lines = stdoutTail
    .split('\n')
    .map((line) => line.trimEnd());
  const responseLines: string[] = [];

  for (const line of lines) {
    if (
      line.startsWith('Created execution plan') ||
      line.startsWith('Expanding hook command') ||
      line.startsWith('Hook execution for ')
    ) {
      break;
    }

    if (!line && responseLines.length == 0) {
      continue;
    }

    responseLines.push(line);
  }

  const text = responseLines.join('\n').trim();
  return text.length > 0 ? text : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeMessageText(value: string | undefined): string {
  return (value ?? '').replaceAll(/\s+/g, ' ').trim();
}
