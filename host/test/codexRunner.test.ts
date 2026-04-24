import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexRunner, buildCodexArgs } from '../src/codexRunner.js';
import type { RunnerControls, RuntimeRun } from '../src/runners.js';
import type { RunRecord, SessionEventRecord, SessionRecord, WorkspaceConfig } from '../src/types.js';
import { createLogger } from './testUtils.js';

test('buildCodexArgs includes the bypass sandbox flag for new Codex runs', () => {
  const args = buildCodexArgs(null, 'hello', false);
  const execIndex = args.indexOf('exec');

  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!args.includes('--full-auto'));
  assert.ok(args.some((value) => value.includes('mcp_servers.gemini_remote_artifacts.command')));
  assert.deepEqual(args.slice(execIndex, execIndex + 4), [
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--enable',
  ]);
});

test('buildCodexArgs includes a model override before exec when provided', () => {
  const args = buildCodexArgs(
    null,
    'hello',
    false,
    undefined,
    'gpt-5.1-codex-mini',
  );
  const execIndex = args.indexOf('exec');

  assert.equal(args[execIndex - 2], '-m');
  assert.equal(args[execIndex - 1], 'gpt-5.1-codex-mini');
});

test('buildCodexArgs includes the bypass sandbox flag for resumed Codex runs', () => {
  const args = buildCodexArgs('thread-123', 'follow up', true);
  const execIndex = args.indexOf('exec');

  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!args.includes('--full-auto'));
  assert.ok(args.some((value) => value.includes('mcp_servers.gemini_remote_artifacts.command')));
  assert.deepEqual(args.slice(execIndex, execIndex + 6), [
    'exec',
    'resume',
    'thread-123',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--enable',
  ]);
});

test('CodexRunner maps file_change items to tool events', () => {
  const runner = new CodexRunner();
  const events: SessionEventRecord[] = [];
  const session: SessionRecord = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    model: null,
    providerSessionId: null,
    geminiSessionId: null,
    transcriptPath: null,
    status: 'running',
    lastMessageStatus: 'running',
    createdAt: '2026-04-23T00:00:00.000Z',
    updatedAt: '2026-04-23T00:00:00.000Z',
    lastActivityAt: '2026-04-23T00:00:00.000Z',
    lastRunId: 'run-1',
    lastPrompt: 'hello',
  };
  const run: RunRecord = {
    id: 'run-1',
    sessionId: session.id,
    model: null,
    status: 'running',
    prompt: 'hello',
    startedAt: '2026-04-23T00:00:00.000Z',
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
    provider: 'codex',
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
      lineBuffer: '',
      messageTextByItemId: new Map(),
      latestMessageItemId: null,
      pendingCompletedMessageItemId: null,
      startedToolIds: new Set<string>(),
      sessionStartedEventEmitted: false,
      turnFailed: false,
      failureMessage: null,
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
    updateSessionMetadata: () => session,
    getSession: () => session,
    getRun: () => run,
    getLatestCompletedMessage: () => null,
    logger: createLogger(),
  };

  runner.handleJsonEvent(
    runtime,
    {
      type: 'item.completed',
      item: {
        id: 'item-1',
        type: 'file_change',
        changes: [
          {
            path: '/tmp/workspace/src/example.ts',
            kind: 'update',
          },
        ],
        status: 'completed',
      },
    },
    controls,
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ['tool.started', 'tool.completed'],
  );
  assert.equal(events[0]?.payload.toolName, 'File Change');
  assert.deepEqual(events[0]?.payload.toolInput, {
    changes: [
      {
        path: '/tmp/workspace/src/example.ts',
        kind: 'update',
      },
    ],
  });
  assert.equal(events[1]?.payload.toolName, 'File Change');
  assert.equal(events[1]?.payload.success, true);
  assert.deepEqual(events[1]?.payload.toolResponse, {
    status: 'completed',
  });
});

test('CodexRunner emits each completed agent message and reserves usage for the final one', () => {
  const runner = new CodexRunner();
  const events: SessionEventRecord[] = [];
  const session: SessionRecord = {
    id: 'session-1',
    workspaceId: 'workspace-1',
    model: null,
    providerSessionId: null,
    geminiSessionId: null,
    transcriptPath: null,
    status: 'running',
    lastMessageStatus: 'running',
    createdAt: '2026-04-23T00:00:00.000Z',
    updatedAt: '2026-04-23T00:00:00.000Z',
    lastActivityAt: '2026-04-23T00:00:00.000Z',
    lastRunId: 'run-1',
    lastPrompt: 'hello',
  };
  const run: RunRecord = {
    id: 'run-1',
    sessionId: session.id,
    model: null,
    status: 'running',
    prompt: 'hello',
    startedAt: '2026-04-23T00:00:00.000Z',
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
    provider: 'codex',
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
      lineBuffer: '',
      messageTextByItemId: new Map(),
      latestMessageItemId: null,
      pendingCompletedMessageItemId: null,
      startedToolIds: new Set<string>(),
      sessionStartedEventEmitted: false,
      turnFailed: false,
      failureMessage: null,
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
    updateSessionMetadata: () => session,
    getSession: () => session,
    getRun: () => run,
    getLatestCompletedMessage: () => null,
    logger: createLogger(),
  };

  runner.handleJsonEvent(
    runtime,
    {
      type: 'item.completed',
      item: {
        id: 'early-message',
        type: 'agent_message',
        text: 'working on it',
      },
    },
    controls,
  );
  runner.handleJsonEvent(
    runtime,
    {
      type: 'item.completed',
      item: {
        id: 'final-message',
        type: 'agent_message',
        text: 'final answer',
      },
    },
    controls,
  );
  runner.handleJsonEvent(
    runtime,
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 10,
        cached_input_tokens: 2,
        output_tokens: 3,
      },
    },
    controls,
  );

  const completedMessages = events.filter((event) => event.type === 'message.completed');
  assert.equal(completedMessages.length, 2);
  assert.deepEqual(completedMessages[0]?.payload, {
    text: 'working on it',
    source: 'codex-jsonl',
  });
  assert.deepEqual(completedMessages[1]?.payload, {
    text: 'final answer',
    source: 'codex-jsonl',
    usage: {
      input: 12,
      output: 3,
      total: 15,
    },
  });
});
