import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { AppDatabase } from '../src/db.js';
import { SessionService } from '../src/sessionService.js';
import type { BroadcastEnvelope, WorkspaceConfig } from '../src/types.js';
import {
  cleanupTempDir,
  createLogger,
  makeTempDir,
  waitFor,
} from './testUtils.js';

test('SessionService creates a Codex session and persists the provider thread id', { concurrency: false }, async (t) => {
  const harness = await createHarness(t);

  const session = harness.service.createSession(
    harness.workspace.id,
    'success scenario',
  );
  const run = await waitFor(
    () => harness.database.getRunOrThrow(session.lastRunId!),
    (value) => value.status !== 'running',
  );
  const updatedSession = harness.database.getSessionOrThrow(session.id);
  const events = harness.database.getEvents(session.id);

  assert.equal(run.status, 'completed');
  assert.equal(updatedSession.providerSessionId, 'thread-success');
  assert.ok(events.some((event) => event.type == 'session.started'));
  assert.ok(
    events.some(
      (event) =>
        event.type == 'message.completed' &&
        event.payload.text == 'hello from codex',
    ),
  );
  assert.ok(events.some((event) => event.type == 'run.completed'));
});

test('SessionService resumes a Codex session using the saved provider session id', { concurrency: false }, async (t) => {
  const harness = await createHarness(t);

  const initialSession = harness.service.createSession(
    harness.workspace.id,
    'success scenario',
  );
  await waitFor(
    () => harness.database.getRunOrThrow(initialSession.lastRunId!),
    (value) => value.status !== 'running',
  );

  const resumedSession = harness.service.sendPrompt(
    initialSession.id,
    'resume scenario',
  );
  const resumedRun = await waitFor(
    () => harness.database.getRunOrThrow(resumedSession.lastRunId!),
    (value) => value.status !== 'running',
  );
  const resumedEvents = harness.database
    .getEvents(initialSession.id)
    .filter((event) => event.runId === resumedRun.id);

  assert.equal(resumedRun.status, 'completed');
  assert.ok(
    resumedEvents.some(
      (event) =>
        event.type == 'message.completed' &&
        event.payload.text == 'resumed:thread-success',
    ),
  );
});

test('SessionService maps Codex tool events and ignores malformed JSONL output', { concurrency: false }, async (t) => {
  const harness = await createHarness(t);

  const session = harness.service.createSession(
    harness.workspace.id,
    'tool malformed scenario',
  );
  const run = await waitFor(
    () => harness.database.getRunOrThrow(session.lastRunId!),
    (value) => value.status !== 'running',
  );
  const events = harness.database
    .getEvents(session.id)
    .filter((event) => event.runId === run.id);

  assert.equal(run.status, 'completed');
  assert.ok(
    events.some(
      (event) =>
        event.type == 'tool.started' &&
        event.payload.toolName == 'Bash',
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type == 'tool.completed' &&
        event.payload.toolName == 'Bash' &&
        event.payload.success == true,
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.type == 'message.completed' &&
        event.payload.text == 'tool done',
    ),
  );
});

test('SessionService cancels an active Codex run', { concurrency: false }, async (t) => {
  const harness = await createHarness(t);

  const session = harness.service.createSession(
    harness.workspace.id,
    'cancel scenario',
  );
  await waitFor(
    () => harness.database.getSessionOrThrow(session.id),
    (value) => value.providerSessionId === 'thread-cancel',
  );

  assert.equal(harness.service.cancelSession(session.id), true);

  const run = await waitFor(
    () => harness.database.getRunOrThrow(session.lastRunId!),
    (value) => value.status !== 'running',
    8000,
  );
  const events = harness.database
    .getEvents(session.id)
    .filter((event) => event.runId === run.id);

  assert.equal(run.status, 'cancelled');
  assert.ok(events.some((event) => event.type == 'run.cancelled'));
});

async function createHarness(t: test.TestContext): Promise<{
  database: AppDatabase;
  service: SessionService;
  workspace: WorkspaceConfig;
  broadcasts: BroadcastEnvelope[];
}> {
  const tempDir = await makeTempDir('gemini-remote-session-service-');
  t.after(async () => {
    await cleanupTempDir(tempDir);
  });

  const workspaceDir = path.join(tempDir, 'workspace');
  const binDir = path.join(tempDir, 'bin');
  const databasePath = path.join(tempDir, 'data', 'app.sqlite');
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeStubCodex(path.join(binDir, 'codex'));

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });

  const workspace: WorkspaceConfig = {
    id: 'workspace-1',
    name: 'Workspace',
    rootPath: workspaceDir,
    provider: 'codex',
  };
  const database = new AppDatabase(databasePath);
  t.after(() => {
    database.close();
  });
  database.syncWorkspaces([workspace]);

  const broadcasts: BroadcastEnvelope[] = [];
  const service = new SessionService(
    database,
    new Map([[workspace.id, workspace]]),
    'http://127.0.0.1:8918',
    createLogger(),
    (envelope) => {
      broadcasts.push(envelope);
    },
  );

  return {
    database,
    service,
    workspace,
    broadcasts,
  };
}

async function writeStubCodex(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const isResume = args[0] === 'exec' && args[1] === 'resume';
const resumeId = isResume ? args[2] : null;
const prompt = args.at(-1) ?? '';

function writeJson(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}

if (prompt.includes('cancel')) {
  writeJson({ type: 'thread.started', thread_id: 'thread-cancel' });
  process.on('SIGINT', () => process.exit(130));
  setInterval(() => {}, 1000);
} else {
  if (prompt.includes('malformed')) {
    process.stdout.write('not json\\n');
  }

  const threadId = isResume ? (resumeId ?? 'thread-resume') : prompt.includes('tool') ? 'thread-tool' : prompt.includes('malformed') ? 'thread-malformed' : 'thread-success';
  writeJson({ type: 'thread.started', thread_id: threadId });
  writeJson({ type: 'turn.started' });

  if (prompt.includes('tool')) {
    writeJson({
      type: 'item.started',
      item: {
        id: 'item-tool',
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        aggregated_output: '',
        exit_code: null,
        status: 'in_progress',
      },
    });
    writeJson({
      type: 'item.completed',
      item: {
        id: 'item-tool',
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        aggregated_output: '/tmp/workspace\\n',
        exit_code: 0,
        status: 'completed',
      },
    });
  }

  writeJson({
    type: 'item.completed',
    item: {
      id: 'item-message',
      type: 'agent_message',
      text: isResume ? 'resumed:' + resumeId : prompt.includes('tool') ? 'tool done' : 'hello from codex',
    },
  });
  writeJson({
    type: 'turn.completed',
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
    },
  });
}
`,
  );
  await chmod(filePath, 0o755);
}
