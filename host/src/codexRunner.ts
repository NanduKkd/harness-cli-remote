import { spawn } from 'node:child_process';

import type { HookIngressBody, RunRecord } from './types.js';
import type {
  RunnerControls,
  RunnerFinalizationResult,
  RuntimeRun,
  SpawnRunArgs,
  WorkspaceRunner,
} from './runners.js';
import { nowIso, summarizeJson } from './util.js';

type CodexRuntimeState = {
  lineBuffer: string;
  messageTextByItemId: Map<string, string>;
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
    const { session, workspace, prompt, resume, daemonUrl, hookToken, runId } = args;
    const child = spawn(
      process.env.CODEX_BIN ?? 'codex',
      buildCodexArgs(session.providerSessionId, prompt, resume),
      {
        cwd: workspace.rootPath,
        env: {
          ...process.env,
          REMOTE_DAEMON_URL: daemonUrl,
          REMOTE_HOOK_TOKEN: hookToken,
          REMOTE_SESSION_ID: session.id,
          REMOTE_RUN_ID: runId,
        },
      },
    );

    return {
      child,
      state: {
        lineBuffer: '',
        messageTextByItemId: new Map(),
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
        controls.emit(runtime.sessionId, runtime.runId, {
          type: 'message.completed',
          payload: {
            text,
            source: 'codex-jsonl',
          },
          ts,
        });
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

function buildCodexArgs(
  sessionId: string | null,
  prompt: string,
  resume: boolean,
): string[] {
  if (resume) {
    return [
      'exec',
      'resume',
      sessionId ?? '',
      '--json',
      '--full-auto',
      '--enable',
      'codex_hooks',
      '--skip-git-repo-check',
      prompt,
    ];
  }

  return [
    'exec',
    '--json',
    '--full-auto',
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
