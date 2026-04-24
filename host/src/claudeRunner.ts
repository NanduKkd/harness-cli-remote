import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { buildClaudeArtifactMcpConfig } from './artifactMcp.js';
import type { HookIngressBody, RunRecord, SessionEventRecord } from './types.js';
import type {
  RunnerControls,
  RunnerFinalizationResult,
  RuntimeRun,
  SpawnRunArgs,
  WorkspaceRunner,
} from './runners.js';
import { resolveExecutable } from './executableResolver.js';
import { nowIso, summarizeJson } from './util.js';

type ClaudeRuntimeState = {
  stdoutBuffer: string;
  startedToolIds: Set<string>;
  completedToolIds: Set<string>;
  sessionStartedEventEmitted: boolean;
  stopFailureMessage: string | null;
};

export class ClaudeRunner implements WorkspaceRunner {
  readonly provider = 'claude' as const;

  spawnRun(args: SpawnRunArgs) {
    const { session, workspace, model, prompt, resume, daemonUrl, hookToken, runId } = args;
    const useProcessGroupSignals = process.platform !== 'win32';
    const child = spawn(
      resolveExecutable('claude', {
        envVar: 'CLAUDE_BIN',
        fallbackPaths: [
          '/opt/homebrew/bin/claude',
          '/usr/local/bin/claude',
          path.join(os.homedir(), '.local', 'bin', 'claude'),
        ],
      }),
      buildClaudeArgs(
        session.id,
        session.providerSessionId,
        prompt,
        resume,
        {
          daemonUrl,
          sessionId: session.id,
          runId,
          hookToken,
          workspaceRoot: workspace.rootPath,
        },
        model,
      ),
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
        sendClaudeSignal(child, signal, useProcessGroupSignals),
      state: {
        stdoutBuffer: '',
        startedToolIds: new Set(),
        completedToolIds: new Set(),
        sessionStartedEventEmitted: false,
        stopFailureMessage: null,
      } satisfies ClaudeRuntimeState,
    };
  }

  handleStdoutChunk(
    runtime: RuntimeRun,
    chunk: string,
    _controls: RunnerControls,
  ): void {
    const state = runtime.state as ClaudeRuntimeState;
    state.stdoutBuffer += chunk;
  }

  handleHookIngress(
    runtime: RuntimeRun,
    body: HookIngressBody,
    controls: RunnerControls,
  ): SessionEventRecord[] {
    const state = runtime.state as ClaudeRuntimeState;
    const hookPayload = body.hookPayload;
    const hookEventName = String(
      hookPayload.hook_event_name ?? hookPayload.hookEventName ?? '',
    );
    const events: SessionEventRecord[] = [];
    const ts = body.receivedAt;

    switch (hookEventName) {
      case 'SessionStart': {
        const providerSessionId = stringOrNull(hookPayload.session_id);
        const transcriptPath = stringOrNull(hookPayload.transcript_path);
        controls.updateSessionMetadata(runtime.sessionId, {
          providerSessionId,
          transcriptPath,
          status: 'running',
        });
        if (!state.sessionStartedEventEmitted) {
          state.sessionStartedEventEmitted = true;
          events.push(
            controls.emit(runtime.sessionId, runtime.runId, {
              type: 'session.started',
              payload: {
                source: hookPayload.source ?? 'hook',
                providerSessionId,
                transcriptPath,
              },
              ts,
            }),
          );
        }
        break;
      }
      case 'PreToolUse': {
        events.push(...emitToolStarted(runtime, hookPayload, controls, state, ts));
        break;
      }
      case 'PostToolUse': {
        events.push(...emitToolStarted(runtime, hookPayload, controls, state, ts));
        events.push(
          ...emitToolCompleted(
            runtime,
            {
              toolName: stringOrNull(hookPayload.tool_name) ?? 'Tool',
              toolInput: asRecord(hookPayload.tool_input),
              toolResponse: coerceToolResponse(hookPayload.tool_response),
              success:
                typeof asRecord(hookPayload.tool_response).success === 'boolean'
                  ? Boolean(asRecord(hookPayload.tool_response).success)
                  : true,
            },
            controls,
            state,
            ts,
            stringOrNull(hookPayload.tool_use_id),
          ),
        );
        break;
      }
      case 'PostToolUseFailure': {
        events.push(...emitToolStarted(runtime, hookPayload, controls, state, ts));
        events.push(
          ...emitToolCompleted(
            runtime,
            {
              toolName: stringOrNull(hookPayload.tool_name) ?? 'Tool',
              toolInput: asRecord(hookPayload.tool_input),
              toolResponse: {
                error: hookPayload.error ?? null,
                isInterrupt: hookPayload.is_interrupt ?? null,
              },
              success: false,
            },
            controls,
            state,
            ts,
            stringOrNull(hookPayload.tool_use_id),
          ),
        );
        break;
      }
      case 'Notification': {
        events.push(
          controls.emit(runtime.sessionId, runtime.runId, {
            type: 'notification',
            payload: {
              notificationType: hookPayload.notification_type ?? null,
              title: hookPayload.title ?? null,
              message: hookPayload.message ?? null,
            },
            ts,
          }),
        );
        break;
      }
      case 'Stop': {
        const message = stringOrNull(hookPayload.last_assistant_message);
        if (message) {
          events.push(
            controls.emit(runtime.sessionId, runtime.runId, {
              type: 'message.completed',
              payload: {
                text: message,
                source: 'claude-stop-hook',
              },
              ts,
            }),
          );
        }
        events.push(
          controls.emit(runtime.sessionId, runtime.runId, {
            type: 'session.ended',
            payload: {
              reason: 'stop',
            },
            ts,
          }),
        );
        break;
      }
      case 'StopFailure': {
        state.stopFailureMessage =
          stringOrNull(hookPayload.last_assistant_message) ??
          stringOrNull(hookPayload.error_details) ??
          stringOrNull(hookPayload.error) ??
          'Claude Code reported a failed turn.';
        events.push(
          controls.emit(runtime.sessionId, runtime.runId, {
            type: 'notification',
            payload: {
              notificationType: 'stop_failure',
              errorType: hookPayload.error ?? null,
              message: state.stopFailureMessage,
              details: hookPayload.error_details ?? null,
            },
            ts,
          }),
        );
        break;
      }
      default:
        controls.logger.debug({ hookEventName }, 'Ignoring unsupported Claude hook event');
    }

    return events;
  }

  finalize(
    runtime: RuntimeRun,
    run: RunRecord,
    code: number | null,
    signal: NodeJS.Signals | null,
    controls: RunnerControls,
  ): RunnerFinalizationResult {
    if (signal === 'SIGINT' || signal === 'SIGKILL' || signal === 'SIGTERM') {
      return {};
    }

    const state = runtime.state as ClaudeRuntimeState;
    const parsedOutput = parseClaudeOutput(state.stdoutBuffer);

    if (parsedOutput?.sessionId && !state.sessionStartedEventEmitted) {
      controls.updateSessionMetadata(runtime.sessionId, {
        providerSessionId: parsedOutput.sessionId,
      });
      controls.emit(runtime.sessionId, runtime.runId, {
        type: 'session.started',
        payload: {
          source: 'stdout',
          providerSessionId: parsedOutput.sessionId,
        },
        ts: nowIso(),
      });
      state.sessionStartedEventEmitted = true;
    }

    const existing = controls.getLatestCompletedMessage(run.id);

    if (
      parsedOutput?.result
    ) {
      const payload: Record<string, unknown> = {
        text: parsedOutput.result,
        source: 'claude-json',
      };

      const usage = parsedOutput.raw.usage as Record<string, number> | undefined;
      if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
        payload.usage = {
          input: usage.input_tokens + (usage.cache_read_input_tokens || 0),
          output: usage.output_tokens,
          total: usage.input_tokens + (usage.cache_read_input_tokens || 0) + usage.output_tokens,
        };
      }

      // Only emit if we have something new to add (like usage) or if no message exists yet.
      if (!existing || (payload.usage && !existing.payload.usage)) {
        controls.emit(runtime.sessionId, runtime.runId, {
          type: 'message.completed',
          payload,
          ts: existing?.ts ?? nowIso(),
        });
      }
    }

    if (code === 0) {
      return {};
    }

    return {
      status: 'failed',
      stderrTail:
        runtime.stderrTail ||
        state.stopFailureMessage ||
        summarizeJson(parsedOutput?.raw ?? null) ||
        'Claude Code reported a failed turn.',
    };
  }
}

export function buildClaudeArgs(
  sessionId: string,
  resumeSessionId: string | null,
  prompt: string,
  resume: boolean,
  mcpConfig: {
    daemonUrl: string;
    sessionId: string;
    runId: string;
    hookToken: string;
    workspaceRoot: string;
  } = {
    daemonUrl: 'http://127.0.0.1:8918',
    sessionId: 'session-test',
    runId: 'run-test',
    hookToken: 'hook-test',
    workspaceRoot: process.cwd(),
  },
  model: string | null = null,
): string[] {
  const modelArgs = model ? ['--model', model] : [];
  const mcpArgs = buildClaudeArtifactMcpConfig(mcpConfig);
  const sessionArgs = resume
    ? ['--resume', resumeSessionId ?? '']
    : ['--session-id', sessionId];

  return [
    ...sessionArgs,
    ...modelArgs,
    '-p',
    prompt,
    '--output-format',
    'json',
    '--dangerously-skip-permissions',
    ...mcpArgs,
  ];
}

function emitToolStarted(
  runtime: RuntimeRun,
  hookPayload: Record<string, unknown>,
  controls: RunnerControls,
  state: ClaudeRuntimeState,
  ts: string,
): SessionEventRecord[] {
  const toolUseId = stringOrNull(hookPayload.tool_use_id);
  if (toolUseId && state.startedToolIds.has(toolUseId)) {
    return [];
  }

  if (toolUseId) {
    state.startedToolIds.add(toolUseId);
  }

  return [
    controls.emit(runtime.sessionId, runtime.runId, {
      type: 'tool.started',
      payload: {
        toolName: stringOrNull(hookPayload.tool_name) ?? 'Tool',
        toolInput: asRecord(hookPayload.tool_input),
        toolInputSummary: summarizeJson(hookPayload.tool_input),
      },
      ts,
    }),
  ];
}

function emitToolCompleted(
  runtime: RuntimeRun,
  input: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolResponse: Record<string, unknown>;
    success: boolean;
  },
  controls: RunnerControls,
  state: ClaudeRuntimeState,
  ts: string,
  toolUseId: string | null,
): SessionEventRecord[] {
  if (toolUseId && state.completedToolIds.has(toolUseId)) {
    return [];
  }

  if (toolUseId) {
    state.completedToolIds.add(toolUseId);
  }

  return [
    controls.emit(runtime.sessionId, runtime.runId, {
      type: 'tool.completed',
      payload: {
        toolName: input.toolName,
        toolInput: input.toolInput,
        toolResponse: input.toolResponse,
        success: input.success,
        toolInputSummary: summarizeJson(input.toolInput),
        toolResponseSummary: summarizeJson(input.toolResponse),
      },
      ts,
    }),
  ];
}

function parseClaudeOutput(output: string): {
  sessionId: string | null;
  result: string | null;
  raw: Record<string, unknown>;
} | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      sessionId: stringOrNull(parsed.session_id),
      result: stringOrNull(parsed.result),
      raw: parsed,
    };
  } catch {
    return null;
  }
}

function sendClaudeSignal(
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

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function coerceToolResponse(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }

  return {
    value: value ?? null,
  };
}
