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
    const parsed = parseGeminiStdout(runtime.stdoutTail);

    // Ensure all transcript messages are reconciled before finalizing
    reconcileTranscript(runtime.runId, controls);

    const latest = controls.getLatestCompletedMessage(run.id);

    const state = runtime.state as GeminiRuntimeState;
    const fallbackText =
      parsed?.response ?? extractGeminiStdoutText(runtime.stdoutTail) ?? state.fallbackMessageText;

    let usage: Record<string, number> | undefined;
    if (parsed?.stats && typeof parsed.stats === 'object') {
      const stats = parsed.stats as any;
      if (stats.tokens) {
        // High-level tokens object
        usage = {
          input: stats.tokens.input ?? 0,
          output: stats.tokens.candidates ?? stats.tokens.output ?? 0,
          total: stats.tokens.total ?? 0,
        };
      } else if (stats.models && typeof stats.models === 'object') {
        // Nested models object
        const models = Object.values(stats.models) as any[];
        let input = 0;
        let output = 0;
        let total = 0;
        for (const m of models) {
          if (m?.tokens) {
            input += m.tokens.input ?? 0;
            output += m.tokens.candidates ?? m.tokens.output ?? 0;
            total += m.tokens.total ?? 0;
          }
        }
        if (total > 0) {
          usage = { input, output, total };
        }
      }
    }

    // If we have usage but the latest message doesn't, we MUST emit/update it.
    if (!latest || (usage && !latest.payload.usage)) {
      const payload: Record<string, unknown> = {
        text: latest?.payload.text ?? fallbackText,
        source: parsed?.response ? 'gemini-json' : (latest?.payload.source ?? 'gemini-stdout-reconcile'),
      };
      if (usage) {
        payload.usage = usage;
      }

      if (!payload.text) {
        return undefined;
      }

      controls.emit(runtime.sessionId, run.id, {
        type: 'message.completed',
        payload,
        ts: latest?.ts ?? nowIso(),
      });
    }

    return undefined;
  }
}

export function buildGeminiArgs(
  session: { providerSessionId: string | null; geminiSessionId: string | null },
  prompt: string,
  resume: boolean,
  model: string | null,
): string[] {
  const args = ['--yolo', '--output-format', 'json'];
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

  const assistantMessages = (snapshot.transcript.messages ?? []).filter(
    (message) =>
      message.type === 'gemini' &&
      typeof message.content === 'string' &&
      (!message.timestamp || message.timestamp >= run.startedAt),
  );

  if (assistantMessages.length === 0) {
    return;
  }

  // We emit messages incrementally.
  // We compare the transcript against the "latest" emitted message.
  for (const message of assistantMessages) {
    const text = message.content as string;
    const existing = controls.getLatestCompletedMessage(run.id);

    const alreadyEmitted = existing &&
      normalizeMessageText(existing.payload.text as string | undefined) === normalizeMessageText(text);

    // If this message (or a later one) has already been emitted, we skip it.
    // Since we are iterating forward, if we find a message that matches 'latest',
    // it means we've already processed this part of the transcript.
    if (!alreadyEmitted) {
      // Check if ANY previous message in this run matches.
      // Since we don't have getRunMessages, we'll just check if the text is different from the latest.
      // This is usually enough for sequential assistant messages.
      controls.emit(session.id, run.id, {
        type: 'message.completed',
        payload: {
          text: text,
          source: 'transcript-reconcile',
        },
        ts: message.timestamp ?? nowIso(),
      });
    }
  }
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

function parseGeminiStdout(stdoutTail: string): { response?: string; stats?: unknown } | null {
  const start = stdoutTail.indexOf('{');
  const end = stdoutTail.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(stdoutTail.slice(start, end + 1)) as { response?: string; stats?: unknown };
    } catch {
      return null;
    }
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeMessageText(value: string | undefined): string {
  return (value ?? '').replaceAll(/\s+/g, ' ').trim();
}
