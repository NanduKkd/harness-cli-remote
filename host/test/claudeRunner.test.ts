import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeRunner, buildClaudeArgs } from '../src/claudeRunner.js';
import type { RunnerControls, RuntimeRun } from '../src/runners.js';
import type {
  HookIngressBody,
  RunRecord,
  SessionEventRecord,
  SessionRecord,
  WorkspaceConfig,
} from '../src/types.js';
import { createLogger } from './testUtils.js';

test('buildClaudeArgs includes session persistence, bypass permissions, and MCP config for new runs', () => {
  const args = buildClaudeArgs('session-123', null, 'hello', false);

  assert.deepEqual(args.slice(0, 7), [
    '--session-id',
    'session-123',
    '-p',
    'hello',
    '--output-format',
    'json',
    '--dangerously-skip-permissions',
  ]);
  const mcpConfigIndex = args.indexOf('--mcp-config');
  assert.ok(mcpConfigIndex > 0);
  const mcpConfig = JSON.parse(args[mcpConfigIndex + 1] ?? '{}') as {
    mcpServers?: Record<string, { command?: string }>;
  };
  assert.equal(
    mcpConfig.mcpServers?.gemini_remote_artifacts?.command,
    'node',
  );
});

test('buildClaudeArgs includes model override and resume session id when provided', () => {
  const args = buildClaudeArgs(
    'session-123',
    'claude-session-1',
    'follow up',
    true,
    undefined,
    'claude-sonnet-4-6',
  );

  assert.deepEqual(args.slice(0, 4), [
    '--resume',
    'claude-session-1',
    '--model',
    'claude-sonnet-4-6',
  ]);
  assert.ok(!args.includes('--session-id'));
  assert.ok(args.includes('follow up'));
});

test('ClaudeRunner maps hook ingress events and falls back to stdout JSON for final output', () => {
  const runner = new ClaudeRunner();
  const events: SessionEventRecord[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const session: SessionRecord = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    model: null,
    providerSessionId: null,
    geminiSessionId: null,
    transcriptPath: null,
    status: 'running',
    lastMessageStatus: 'running',
    createdAt: '2026-04-18T00:00:00.000Z',
    updatedAt: '2026-04-18T00:00:00.000Z',
    lastActivityAt: '2026-04-18T00:00:00.000Z',
    lastRunId: 'run-1',
    lastPrompt: 'hello',
  };
  const run: RunRecord = {
    id: 'run-1',
    sessionId: session.id,
    model: null,
    status: 'running',
    prompt: 'hello',
    startedAt: '2026-04-18T00:00:00.000Z',
    endedAt: null,
    exitCode: null,
    cancelledByUser: false,
    stdoutTail: '',
    stderrTail: '',
  };
  const workspace: WorkspaceConfig = {
    id: 'workspace-1',
    name: 'Workspace',
    rootPath: '/tmp/workspace',
    provider: 'claude',
  };
  const runtime = {
    child: {} as RuntimeRun['child'],
    runId: run.id,
    sessionId: session.id,
    workspace,
    hookToken: 'hook-1',
    stdoutTail: '',
    stderrTail: '',
    cancelTimer: null,
    cancelRequestedByUser: false,
    sendSignal() {},
    runner,
    state: {
      stdoutBuffer: '',
      startedToolIds: new Set<string>(),
      completedToolIds: new Set<string>(),
      sessionStartedEventEmitted: false,
      stopFailureMessage: null,
    },
  } satisfies RuntimeRun;
  const controls: RunnerControls = {
    emit: (sessionId, runId, event) => {
      const record: SessionEventRecord = {
        sessionId,
        runId,
        seq: events.length + 1,
        type: event.type,
        ts: event.ts,
        payload: event.payload,
      };
      events.push(record);
      return record;
    },
    updateSessionMetadata: (_sessionId, input) => {
      updates.push(input);
      return {
        ...session,
        ...input,
      };
    },
    getSession: () => session,
    getRun: () => run,
    getLatestCompletedMessage: (runId) =>
      events.findLast(
        (event) => event.runId === runId && event.type === 'message.completed',
      ) ?? null,
    logger: createLogger(),
  };

  const sessionStartBody: HookIngressBody = {
    remoteSessionId: session.id,
    remoteRunId: run.id,
    receivedAt: '2026-04-18T00:00:01.000Z',
    hookPayload: {
      hook_event_name: 'SessionStart',
      session_id: 'claude-session-1',
      transcript_path: '/tmp/workspace/.claude/transcript.jsonl',
    },
  };
  const toolStartBody: HookIngressBody = {
    remoteSessionId: session.id,
    remoteRunId: run.id,
    receivedAt: '2026-04-18T00:00:02.000Z',
    hookPayload: {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: 'pwd',
      },
      tool_use_id: 'tool-1',
    },
  };
  const toolEndBody: HookIngressBody = {
    remoteSessionId: session.id,
    remoteRunId: run.id,
    receivedAt: '2026-04-18T00:00:03.000Z',
    hookPayload: {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: 'pwd',
      },
      tool_response: {
        stdout: '/tmp/workspace\n',
        exitCode: 0,
      },
      tool_use_id: 'tool-1',
    },
  };

  runner.handleHookIngress(runtime, sessionStartBody, controls);
  runner.handleHookIngress(runtime, toolStartBody, controls);
  runner.handleHookIngress(runtime, toolEndBody, controls);
  runner.handleStdoutChunk(
    runtime,
    JSON.stringify({
      session_id: 'claude-session-1',
      result: 'hello from claude',
    }),
    controls,
  );
  const finalization = runner.finalize(runtime, run, 0, null, controls);

  assert.deepEqual(finalization, {});
  assert.ok(
    updates.some((value) => value.providerSessionId === 'claude-session-1'),
  );
  assert.ok(events.some((event) => event.type === 'session.started'));
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool.started' && event.payload.toolName === 'Bash',
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool.completed' &&
        event.payload.toolName === 'Bash' &&
        event.payload.success === true,
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === 'message.completed' &&
        event.payload.text === 'hello from claude',
    ),
  );
});
