import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { buildCodexArtifactMcpConfig } from './artifactMcp.js';
import type { HookIngressBody, RunRecord } from './types.js';
import type {
  RunnerControls,
  RunnerFinalizationResult,
  RuntimeRun,
  SpawnRunArgs,
  WorkspaceRunner,
} from './runners.js';
import { resolveExecutable } from './executableResolver.js';
import { nowIso, summarizeJson } from './util.js';

type CodexRuntimeState = {
  lineBuffer: string;
  messageTextByItemId: Map<string, string>;
  latestMessageItemId: string | null;
  pendingCompletedMessageItemId: string | null;
  startedToolIds: Set<string>;
  sessionStartedEventEmitted: boolean;
  turnFailed: boolean;
  failureMessage: string | null;
};

type CodexJsonEvent = Record<string, unknown> & {
  type?: string;
  item?: Record<string, unknown>;
  thread_id?: string;
};

export class CodexRunner implements WorkspaceRunner {
  readonly provider = 'codex' as const;

  spawnRun(args: SpawnRunArgs) {
    const { session, workspace, model, prompt, resume, daemonUrl, hookToken, runId } = args;
    const useProcessGroupSignals = process.platform !== 'win32';
    const child = spawn(
      resolveExecutable('codex', {
        envVar: 'CODEX_BIN',
        fallbackPaths: [
          '/Applications/Codex.app/Contents/Resources/codex',
          path.join(
            os.homedir(),
            'Applications',
            'Codex.app',
            'Contents',
            'Resources',
            'codex',
          ),
          '/opt/homebrew/bin/codex',
          '/usr/local/bin/codex',
          path.join(os.homedir(), '.local', 'bin', 'codex'),
        ],
      }),
      buildCodexArgs(
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
        sendCodexSignal(child, signal, useProcessGroupSignals),
      state: {
        lineBuffer: '',
        messageTextByItemId: new Map(),
        latestMessageItemId: null,
        pendingCompletedMessageItemId: null,
        startedToolIds: new Set(),
        sessionStartedEventEmitted: false,
        turnFailed: false,
        failureMessage: null,
      } satisfies CodexRuntimeState,
    };
  }

  handleStdoutChunk(
    runtime: RuntimeRun,
    chunk: string,
    controls: RunnerControls,
  ): void {
    const state = runtime.state as CodexRuntimeState;
    state.lineBuffer += chunk;

    while (true) {
      const newlineIndex = state.lineBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = state.lineBuffer.slice(0, newlineIndex).trim();
      state.lineBuffer = state.lineBuffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      let parsed: CodexJsonEvent;
      try {
        parsed = JSON.parse(line) as CodexJsonEvent;
      } catch (_error) {
        controls.logger.debug({ line }, 'Ignoring malformed Codex JSONL line');
        continue;
      }

      this.handleJsonEvent(runtime, parsed, controls);
    }
  }

  handleHookIngress(
    runtime: RuntimeRun,
    body: HookIngressBody,
    controls: RunnerControls,
  ) {
    const state = runtime.state as CodexRuntimeState;
    const hookEventName = String(body.hookPayload.hookEventName ?? body.hookPayload.hook_event_name ?? '');
    if (hookEventName !== 'SessionStart') {
      controls.logger.debug({ hookEventName }, 'Ignoring unsupported Codex hook event');
      return [];
    }

    controls.updateSessionMetadata(runtime.sessionId, {
      status: 'running',
    });

    if (state.sessionStartedEventEmitted) {
      return [];
    }

    state.sessionStartedEventEmitted = true;
    return [
      controls.emit(runtime.sessionId, runtime.runId, {
        type: 'session.started',
        payload: {
          source: body.hookPayload.source ?? null,
          providerSessionId: null,
        },
        ts: body.receivedAt,
      }),
    ];
  }

  finalize(
    runtime: RuntimeRun,
    _run: RunRecord,
    code: number | null,
    signal: NodeJS.Signals | null,
    _controls: RunnerControls,
  ): RunnerFinalizationResult {
    const state = runtime.state as CodexRuntimeState;
    const line = state.lineBuffer.trim();
    if (line) {
      try {
        this.handleJsonEvent(
          runtime,
          JSON.parse(line) as CodexJsonEvent,
          _controls,
        );
      } catch (_error) {
        _controls.logger.debug({ line }, 'Ignoring malformed trailing Codex JSONL line');
      }
    }

    if (signal === 'SIGINT' || signal === 'SIGKILL') {
      return {};
    }

    if (!state.turnFailed) {
      return {};
    }

    return {
      status: 'failed',
      stderrTail:
        runtime.stderrTail ||
        state.failureMessage ||
        'Codex reported the turn as failed.',
    };
  }

  handleJsonEvent(
    runtime: RuntimeRun,
    event: CodexJsonEvent,
    controls: RunnerControls,
  ): void {
    const state = runtime.state as CodexRuntimeState;
    const eventType = String(event.type ?? '');
    const ts = nowIso();

    switch (eventType) {
      case 'thread.started': {
        const threadId = stringOrNull(event.thread_id);
        controls.updateSessionMetadata(runtime.sessionId, {
          providerSessionId: threadId,
          status: 'running',
        });
        if (!state.sessionStartedEventEmitted) {
          state.sessionStartedEventEmitted = true;
          controls.emit(runtime.sessionId, runtime.runId, {
            type: 'session.started',
            payload: {
              source: 'exec',
              providerSessionId: threadId,
            },
            ts,
          });
        }
        break;
      }
      case 'turn.failed':
      case 'error': {
        state.turnFailed = true;
        state.failureMessage =
          extractFailureMessage(event) ?? state.failureMessage ?? 'Codex reported a failed turn.';
        controls.emit(runtime.sessionId, runtime.runId, {
          type: 'notification',
          payload: {
            notificationType: eventType,
            message: state.failureMessage,
            details: summarizeJson(event),
          },
          ts,
        });
        break;
      }
      case 'turn.completed': {
        const usage = event.usage as Record<string, number> | undefined;
        let payloadUsage: Record<string, number> | undefined;
        if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
          payloadUsage = {
            input: usage.input_tokens + (usage.cached_input_tokens || 0),
            output: usage.output_tokens,
            total: usage.input_tokens + (usage.cached_input_tokens || 0) + usage.output_tokens,
          };
        }

        const latestMessageText = state.pendingCompletedMessageItemId
          ? state.messageTextByItemId.get(state.pendingCompletedMessageItemId)
          : null;
        if (latestMessageText) {
          controls.emit(runtime.sessionId, runtime.runId, {
            type: 'message.completed',
            payload: {
              text: latestMessageText,
              source: 'codex-jsonl',
              ...(payloadUsage ? { usage: payloadUsage } : {}),
            },
            ts,
          });
          state.pendingCompletedMessageItemId = null;
        }
        break;
      }
      case 'item.started':
      case 'item.completed': {
        const item = event.item;
        if (item && typeof item === 'object') {
          this.handleItemEvent(runtime, eventType, item, controls);
        }
        break;
      }
      default:
        break;
    }
  }

  private handleItemEvent(
    runtime: RuntimeRun,
    eventType: 'item.started' | 'item.completed' | string,
    item: Record<string, unknown>,
    controls: RunnerControls,
  ): void {
    const state = runtime.state as CodexRuntimeState;
    const ts = nowIso();
    const itemId = String(item.id ?? '');
    const itemType = String(item.type ?? '');

    if (itemType === 'agent_message') {
      const text = stringOrNull(item.text);
      if (!text) {
        return;
      }

      const previous = state.messageTextByItemId.get(itemId) ?? '';
      state.messageTextByItemId.set(itemId, text);
      state.latestMessageItemId = itemId;

      if (previous && text.startsWith(previous) && text.length > previous.length) {
        controls.emit(runtime.sessionId, runtime.runId, {
          type: 'message.delta',
          payload: {
            text: text.slice(previous.length),
            fullText: text,
          },
          ts,
        });
      }

      if (eventType === 'item.completed') {
        if (
          state.pendingCompletedMessageItemId &&
          state.pendingCompletedMessageItemId !== itemId
        ) {
          const pendingText = state.messageTextByItemId.get(state.pendingCompletedMessageItemId);
          if (pendingText) {
            controls.emit(runtime.sessionId, runtime.runId, {
              type: 'message.completed',
              payload: {
                text: pendingText,
                source: 'codex-jsonl',
              },
              ts,
            });
          }
        }
        state.pendingCompletedMessageItemId = itemId;
      }
      return;
    }

    const tool = describeToolItem(item);
    if (tool) {
      if (eventType === 'item.started' && !state.startedToolIds.has(itemId)) {
        state.startedToolIds.add(itemId);
        controls.emit(runtime.sessionId, runtime.runId, {
          type: 'tool.started',
          payload: {
            toolName: tool.name,
            toolInput: tool.input,
            toolInputSummary: summarizeJson(tool.input) ?? summarizeJson(item),
          },
          ts,
        });
      }

      if (eventType === 'item.completed') {
        if (!state.startedToolIds.has(itemId)) {
          state.startedToolIds.add(itemId);
          controls.emit(runtime.sessionId, runtime.runId, {
            type: 'tool.started',
            payload: {
              toolName: tool.name,
              toolInput: tool.input,
              toolInputSummary: summarizeJson(tool.input) ?? summarizeJson(item),
            },
            ts,
          });
        }

        controls.emit(runtime.sessionId, runtime.runId, {
          type: 'tool.completed',
          payload: {
            toolName: tool.name,
            toolInput: tool.input,
            toolResponse: tool.response,
            success: tool.success,
            toolInputSummary: summarizeJson(tool.input) ?? summarizeJson(item),
            toolResponseSummary: summarizeJson(tool.response) ?? summarizeJson(item),
          },
          ts,
        });
      }
      return;
    }

    if (eventType === 'item.completed') {
      controls.emit(runtime.sessionId, runtime.runId, {
        type: 'notification',
        payload: {
          notificationType: itemType || 'item.completed',
          message: `Codex reported ${humanizeItemType(itemType)} activity.`,
          details: summarizeJson(item),
        },
        ts,
      });
    }
  }
}

function sendCodexSignal(
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

export function buildCodexArgs(
  sessionId: string | null,
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
  const mcpArgs = buildCodexArtifactMcpConfig(mcpConfig);
  const modelArgs = model ? ['-m', model] : [];

  if (resume) {
    return [
      ...mcpArgs,
      ...modelArgs,
      'exec',
      'resume',
      sessionId ?? '',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '--enable',
      'codex_hooks',
      '--skip-git-repo-check',
      prompt,
    ];
  }

  return [
    ...mcpArgs,
    ...modelArgs,
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--enable',
    'codex_hooks',
    '--skip-git-repo-check',
    prompt,
  ];
}

function extractFailureMessage(event: CodexJsonEvent): string | null {
  return (
    stringOrNull(event.message) ??
    stringOrNull(event.reason) ??
    stringOrNull(
      event.error && typeof event.error === 'object'
        ? (event.error as Record<string, unknown>).message
        : null,
    ) ??
    summarizeJson(event)
  );
}

function describeToolItem(
  item: Record<string, unknown>,
): {
  name: string;
  input: Record<string, unknown>;
  response: Record<string, unknown>;
  success: boolean;
} | null {
  const itemType = String(item.type ?? '');

  if (itemType === 'command_execution') {
    const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
    return {
      name: 'Bash',
      input: {
        command: item.command ?? null,
      },
      response: {
        output: item.aggregated_output ?? null,
        exitCode,
        status: item.status ?? null,
      },
      success: exitCode === null || exitCode === 0,
    };
  }

  if (itemType === 'file_change') {
    return {
      name: 'File Change',
      input: {
        changes: item.changes ?? null,
      },
      response: {
        status: item.status ?? null,
      },
      success: !item.error,
    };
  }

  if (!/(mcp|web|tool)/i.test(itemType)) {
    return null;
  }

  const name =
    stringOrNull(item.tool_name) ??
    stringOrNull(item.name) ??
    (itemType.includes('web') ? 'Web Search' : humanizeItemType(itemType));
  const input = {
    arguments:
      item.arguments ??
      item.input ??
      item.query ??
      item.command ??
      item.url ??
      null,
    server: item.server ?? null,
    type: item.type ?? null,
  };
  const response = {
    output:
      item.output ??
      item.result ??
      item.response ??
      item.results ??
      item.aggregated_output ??
      null,
    status: item.status ?? null,
    error: item.error ?? null,
    type: item.type ?? null,
  };

  return {
    name,
    input,
    response,
    success: !item.error,
  };
}

function humanizeItemType(value: string): string {
  if (!value) {
    return 'background';
  }

  return value
    .split(/[_\-.]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
