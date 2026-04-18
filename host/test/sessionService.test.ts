import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { AppDatabase } from '../src/db.js';
import { SessionService } from '../src/sessionService.js';
import type {
  BroadcastEnvelope,
  WorkspaceConfig,
  WorkspaceProvider,
} from '../src/types.js';
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
    'gpt-5.1-codex-max',
  );
  const run = await waitFor(
    () => harness.database.getRunOrThrow(session.lastRunId!),
    (value) => value.status !== 'running',
  );
  const updatedSession = harness.database.getSessionOrThrow(session.id);
  const events = harness.database.getEvents(session.id);

  assert.equal(run.status, 'completed');
  assert.equal(run.model, 'gpt-5.1-codex-max');
  assert.equal(updatedSession.model, 'gpt-5.1-codex-max');
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
    'gpt-5.1-codex-max',
  );
  await waitFor(
    () => harness.database.getRunOrThrow(initialSession.lastRunId!),
    (value) => value.status !== 'running',
  );

  const resumedSession = harness.service.sendPrompt(
    initialSession.id,
    'resume scenario',
    'gpt-5.1-codex-mini',
  );
  const resumedRun = await waitFor(
    () => harness.database.getRunOrThrow(resumedSession.lastRunId!),
    (value) => value.status !== 'running',
  );
  const resumedEvents = harness.database
    .getEvents(initialSession.id)
    .filter((event) => event.runId === resumedRun.id);

  assert.equal(resumedRun.status, 'completed');
  assert.equal(resumedRun.model, 'gpt-5.1-codex-mini');
  assert.equal(
    harness.database.getSessionOrThrow(initialSession.id).model,
    'gpt-5.1-codex-mini',
  );
  assert.ok(
    resumedEvents.some(
      (event) =>
        event.type == 'message.completed' &&
        event.payload.text == 'resumed:thread-success',
    ),
  );
});

test('SessionService recovers a Gemini session id from the transcript before resuming', { concurrency: false }, async (t) => {
  const harness = await createHarness(t, { provider: 'gemini' });
  const session = harness.database.createSession(randomUUID(), harness.workspace.id);
  const transcriptPath = path.join(
    harness.workspace.rootPath,
    'transcripts',
    'gemini-session-1.json',
  );

  await mkdir(path.dirname(transcriptPath), { recursive: true });
  await writeFile(
    transcriptPath,
    JSON.stringify({
      sessionId: 'gemini-session-1',
      messages: [],
    }),
  );

  harness.database.updateSessionMetadata(session.id, {
    transcriptPath,
  });

  const resumedSession = harness.service.sendPrompt(
    session.id,
    'resume from transcript scenario',
  );
  const resumedRun = await waitFor(
    () => harness.database.getRunOrThrow(resumedSession.lastRunId!),
    (value) => value.status !== 'running',
  );
  const resumedEvents = harness.database
    .getEvents(session.id)
    .filter((event) => event.runId === resumedRun.id);
  const updatedSession = harness.database.getSessionOrThrow(session.id);

  assert.equal(resumedRun.status, 'completed');
  assert.equal(updatedSession.providerSessionId, 'gemini-session-1');
  assert.equal(updatedSession.geminiSessionId, 'gemini-session-1');
  assert.ok(
    resumedEvents.some(
      (event) =>
        event.type == 'message.completed' &&
        event.payload.text == 'Gemini resumed gemini-session-1.',
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

test('SessionService cancels the full Codex process tree', { concurrency: false }, async (t) => {
  if (process.platform === 'win32') {
    t.skip('Process-group cancellation is only exercised on POSIX hosts.');
    return;
  }

  const harness = await createHarness(t);
  const heartbeatPath = path.join(
    harness.workspace.rootPath,
    'codex-tree-heartbeat.log',
  );
  const pidPath = path.join(harness.workspace.rootPath, 'codex-tree.pid');
  const previousHeartbeatPath = process.env.CODEX_TREE_HEARTBEAT_PATH;
  const previousPidPath = process.env.CODEX_TREE_PID_PATH;
  process.env.CODEX_TREE_HEARTBEAT_PATH = heartbeatPath;
  process.env.CODEX_TREE_PID_PATH = pidPath;
  t.after(() => {
    if (previousHeartbeatPath === undefined) {
      delete process.env.CODEX_TREE_HEARTBEAT_PATH;
    } else {
      process.env.CODEX_TREE_HEARTBEAT_PATH = previousHeartbeatPath;
    }

    if (previousPidPath === undefined) {
      delete process.env.CODEX_TREE_PID_PATH;
    } else {
      process.env.CODEX_TREE_PID_PATH = previousPidPath;
    }

    if (!existsSync(pidPath)) {
      return;
    }

    const pid = Number(readFileSync(pidPath, 'utf8').trim());
    if (!Number.isFinite(pid) || pid <= 0) {
      return;
    }

    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  });

  const session = harness.service.createSession(
    harness.workspace.id,
    'cancel tree scenario',
  );
  await waitFor(
    () => harness.database.getSessionOrThrow(session.id),
    (value) => value.providerSessionId === 'thread-cancel',
  );
  const activeHeartbeatSize = await waitFor(
    () => (existsSync(heartbeatPath) ? statSync(heartbeatPath).size : 0),
    (value) => value >= 2,
    8000,
  );

  assert.equal(harness.service.cancelSession(session.id), true);

  const run = await waitFor(
    () => harness.database.getRunOrThrow(session.lastRunId!),
    (value) => value.status !== 'running',
    8000,
  );

  assert.equal(run.status, 'cancelled');
  assert.ok(activeHeartbeatSize >= 2);

  await new Promise((resolve) => setTimeout(resolve, 350));
  const heartbeatAfterCancel = existsSync(heartbeatPath)
    ? statSync(heartbeatPath).size
    : 0;
  await new Promise((resolve) => setTimeout(resolve, 350));
  const heartbeatLater = existsSync(heartbeatPath)
    ? statSync(heartbeatPath).size
    : 0;

  assert.equal(heartbeatLater, heartbeatAfterCancel);
});

test('SessionService keeps a Gemini run completed when cancel was requested but the CLI exits cleanly', { concurrency: false }, async (t) => {
  const harness = await createHarness(t, { provider: 'gemini' });
  const readyPath = path.join(
    harness.workspace.rootPath,
    'gemini-cancel-ignore.ready',
  );
  const helperReadyPath = path.join(
    harness.workspace.rootPath,
    'gemini-cancel-ignore-helper.ready',
  );
  const previousReadyPath = process.env.GEMINI_CANCEL_READY_PATH;
  const previousHelperReadyPath = process.env.GEMINI_CANCEL_HELPER_READY_PATH;
  process.env.GEMINI_CANCEL_READY_PATH = readyPath;
  process.env.GEMINI_CANCEL_HELPER_READY_PATH = helperReadyPath;
  t.after(() => {
    if (previousReadyPath === undefined) {
      delete process.env.GEMINI_CANCEL_READY_PATH;
    } else {
      process.env.GEMINI_CANCEL_READY_PATH = previousReadyPath;
    }

    if (previousHelperReadyPath === undefined) {
      delete process.env.GEMINI_CANCEL_HELPER_READY_PATH;
    } else {
      process.env.GEMINI_CANCEL_HELPER_READY_PATH = previousHelperReadyPath;
    }
  });

  const session = harness.service.createSession(
    harness.workspace.id,
    'cancel ignored scenario',
  );
  await waitFor(
    () => existsSync(readyPath) && existsSync(helperReadyPath),
    (value) => value,
    8000,
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

  assert.equal(run.status, 'completed');
  assert.equal(run.cancelledByUser, false);
  assert.ok(events.some((event) => event.type == 'run.completed'));
  assert.ok(!events.some((event) => event.type == 'run.cancelled'));
});

test('SessionService cancels the full Gemini process tree', { concurrency: false }, async (t) => {
  if (process.platform === 'win32') {
    t.skip('Process-group cancellation is only exercised on POSIX hosts.');
    return;
  }

  const harness = await createHarness(t, { provider: 'gemini' });
  const heartbeatPath = path.join(
    harness.workspace.rootPath,
    'gemini-tree-heartbeat.log',
  );
  const pidPath = path.join(harness.workspace.rootPath, 'gemini-tree.pid');
  const previousHeartbeatPath = process.env.GEMINI_TREE_HEARTBEAT_PATH;
  const previousPidPath = process.env.GEMINI_TREE_PID_PATH;
  process.env.GEMINI_TREE_HEARTBEAT_PATH = heartbeatPath;
  process.env.GEMINI_TREE_PID_PATH = pidPath;
  t.after(() => {
    if (previousHeartbeatPath === undefined) {
      delete process.env.GEMINI_TREE_HEARTBEAT_PATH;
    } else {
      process.env.GEMINI_TREE_HEARTBEAT_PATH = previousHeartbeatPath;
    }

    if (previousPidPath === undefined) {
      delete process.env.GEMINI_TREE_PID_PATH;
    } else {
      process.env.GEMINI_TREE_PID_PATH = previousPidPath;
    }

    if (!existsSync(pidPath)) {
      return;
    }

    const pid = Number(readFileSync(pidPath, 'utf8').trim());
    if (!Number.isFinite(pid) || pid <= 0) {
      return;
    }

    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  });

  const session = harness.service.createSession(
    harness.workspace.id,
    'cancel tree scenario',
  );
  const activeHeartbeatSize = await waitFor(
    () => (existsSync(heartbeatPath) ? statSync(heartbeatPath).size : 0),
    (value) => value >= 2,
    8000,
  );

  assert.equal(harness.service.cancelSession(session.id), true);

  const run = await waitFor(
    () => harness.database.getRunOrThrow(session.lastRunId!),
    (value) => value.status !== 'running',
    8000,
  );

  assert.equal(run.status, 'cancelled');
  assert.equal(run.cancelledByUser, true);
  assert.ok(activeHeartbeatSize >= 2);

  await new Promise((resolve) => setTimeout(resolve, 350));
  const heartbeatAfterCancel = existsSync(heartbeatPath)
    ? statSync(heartbeatPath).size
    : 0;
  await new Promise((resolve) => setTimeout(resolve, 350));
  const heartbeatLater = existsSync(heartbeatPath)
    ? statSync(heartbeatPath).size
    : 0;

  assert.equal(heartbeatLater, heartbeatAfterCancel);
});

test('SessionService finalizes a Codex run that exits before listeners would previously attach', { concurrency: false }, async (t) => {
  const harness = await createHarness(t);

  const session = harness.service.createSession(
    harness.workspace.id,
    'instant fail scenario',
  );
  const run = await waitFor(
    () => harness.database.getRunOrThrow(session.lastRunId!),
    (value) => value.status !== 'running',
  );
  const events = harness.database
    .getEvents(session.id)
    .filter((event) => event.runId === run.id);

  assert.equal(run.status, 'failed');
  assert.equal(run.exitCode, 17);
  assert.ok(events.some((event) => event.type == 'run.failed'));
});

test('SessionService reports an actionable error when the Codex executable cannot be launched', { concurrency: false }, async (t) => {
  const missingCodexPath = path.join(
    '/tmp',
    `codex-missing-${randomUUID()}`,
  );
  const previousCodexBin = process.env.CODEX_BIN;
  process.env.CODEX_BIN = missingCodexPath;
  t.after(() => {
    if (previousCodexBin === undefined) {
      delete process.env.CODEX_BIN;
      return;
    }
    process.env.CODEX_BIN = previousCodexBin;
  });

  const harness = await createHarness(t, { installCodexStub: false });

  const session = harness.service.createSession(
    harness.workspace.id,
    'missing codex binary scenario',
  );
  const run = await waitFor(
    () => harness.database.getRunOrThrow(session.lastRunId!),
    (value) => value.status !== 'running',
  );

  assert.equal(run.status, 'failed');
  assert.match(run.stderrTail, /Unable to launch Codex CLI/);
  assert.match(run.stderrTail, /CODEX_BIN/);
});

test('SessionService reconciles a detached running session', { concurrency: false }, async (t) => {
  const harness = await createHarness(t);

  const session = harness.database.createSession(randomUUID(), harness.workspace.id);
  const run = harness.database.createRun(
    randomUUID(),
    session.id,
    'detached scenario',
  );

  assert.equal(harness.service.reconcileDetachedSession(session.id), true);

  const updatedRun = harness.database.getRunOrThrow(run.id);
  const updatedSession = harness.database.getSessionOrThrow(session.id);
  const events = harness.database
    .getEvents(session.id)
    .filter((event) => event.runId === run.id);

  assert.equal(updatedRun.status, 'failed');
  assert.equal(updatedSession.status, 'failed');
  assert.ok(events.some((event) => event.type == 'run.failed'));
});

test('SessionService snapshots shared artifacts from an active run', { concurrency: false }, async (t) => {
  const harness = await createHarness(t);
  const sourcePath = path.join(harness.workspace.rootPath, 'report.json');
  await writeFile(sourcePath, '{"ok":true}\n');

  const session = harness.service.createSession(
    harness.workspace.id,
    'cancel scenario',
  );
  await waitFor(
    () => harness.database.getSessionOrThrow(session.id),
    (value) => value.providerSessionId === 'thread-cancel',
  );

  const runtime = (
    harness.service as unknown as {
      runtimesBySession: Map<
        string,
        {
          hookToken: string;
          runId: string;
        }
      >;
    }
  ).runtimesBySession.get(session.id);
  assert.ok(runtime);

  const artifact = harness.service.registerArtifact(runtime.hookToken, {
    remoteSessionId: session.id,
    remoteRunId: runtime.runId,
    path: 'report.json',
    requestedAt: '2026-03-04T00:00:00.000Z',
  });

  const storedArtifact = harness.database.getArtifactOrThrow(artifact.id);
  const events = harness.database
    .getEvents(session.id)
    .filter((event) => event.type === 'artifact.shared');

  assert.equal(artifact.sourcePath, 'report.json');
  assert.equal(artifact.downloadPath, `/artifacts/${artifact.id}/download`);
  assert.equal(storedArtifact.filename, 'report.json');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.payload.artifactId, artifact.id);

  assert.equal(harness.service.cancelSession(session.id), true);
  await waitFor(
    () => harness.database.getRunOrThrow(session.lastRunId!),
    (value) => value.status !== 'running',
    8000,
  );
});

test('SessionService deletes completed and cancelled sessions', { concurrency: false }, async (t) => {
  const harness = await createHarness(t);

  const completedSession = harness.database.createSession(
    randomUUID(),
    harness.workspace.id,
  );
  const completedRun = harness.database.createRun(
    randomUUID(),
    completedSession.id,
    'completed run',
  );
  harness.database.finishRun(completedRun.id, {
    status: 'completed',
    exitCode: 0,
    stdoutTail: '',
    stderrTail: '',
  });

  const cancelledSession = harness.database.createSession(
    randomUUID(),
    harness.workspace.id,
  );
  const cancelledRun = harness.database.createRun(
    randomUUID(),
    cancelledSession.id,
    'cancelled run',
  );
  harness.database.finishRun(cancelledRun.id, {
    status: 'cancelled',
    exitCode: 130,
    stdoutTail: '',
    stderrTail: '',
    cancelledByUser: true,
  });

  assert.equal(harness.service.deleteSession(completedSession.id), 'deleted');
  assert.equal(harness.service.deleteSession(cancelledSession.id), 'deleted');
  assert.equal(harness.database.getSession(completedSession.id), null);
  assert.equal(harness.database.getSession(cancelledSession.id), null);
});

test('SessionService rejects deleting running or failed sessions', { concurrency: false }, async (t) => {
  const harness = await createHarness(t);

  const runningSession = harness.database.createSession(
    randomUUID(),
    harness.workspace.id,
  );
  harness.database.createRun(randomUUID(), runningSession.id, 'running run');

  const failedSession = harness.database.createSession(
    randomUUID(),
    harness.workspace.id,
  );
  const failedRun = harness.database.createRun(
    randomUUID(),
    failedSession.id,
    'failed run',
  );
  harness.database.finishRun(failedRun.id, {
    status: 'failed',
    exitCode: 1,
    stdoutTail: '',
    stderrTail: 'failed',
  });

  assert.equal(harness.service.deleteSession(runningSession.id), 'active');
  assert.equal(harness.service.deleteSession(failedSession.id), 'not_allowed');
  assert.notEqual(harness.database.getSession(runningSession.id), null);
  assert.notEqual(harness.database.getSession(failedSession.id), null);
});

test('SessionService cleans stored artifact directories when deleting a session', { concurrency: false }, async (t) => {
  const harness = await createHarness(t);

  const session = harness.database.createSession(randomUUID(), harness.workspace.id);
  const run = harness.database.createRun(randomUUID(), session.id, 'artifact run');
  harness.database.finishRun(run.id, {
    status: 'completed',
    exitCode: 0,
    stdoutTail: '',
    stderrTail: '',
  });

  const artifactId = randomUUID();
  const artifactDir = path.join(harness.artifactsRoot, artifactId);
  const storedPath = path.join(artifactDir, 'result.txt');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(storedPath, 'artifact');
  harness.database.createArtifact({
    id: artifactId,
    sessionId: session.id,
    runId: run.id,
    workspaceId: harness.workspace.id,
    sourcePath: 'result.txt',
    storedPath,
    filename: 'result.txt',
    mediaType: 'text/plain',
    sizeBytes: 8,
    sha256: 'hash',
    createdAt: '2026-03-04T00:00:00.000Z',
  });

  assert.equal(harness.service.deleteSession(session.id), 'deleted');
  assert.equal(existsSync(artifactDir), false);
});

async function createHarness(
  t: test.TestContext,
  options: {
    installCodexStub?: boolean;
    installGeminiStub?: boolean;
    provider?: WorkspaceProvider;
  } = {},
): Promise<{
  database: AppDatabase;
  service: SessionService;
  workspace: WorkspaceConfig;
  broadcasts: BroadcastEnvelope[];
  artifactsRoot: string;
}> {
  const tempDir = await makeTempDir('gemini-remote-session-service-');
  t.after(async () => {
    await cleanupTempDir(tempDir);
  });

  const workspaceDir = path.join(tempDir, 'workspace');
  const binDir = path.join(tempDir, 'bin');
  const databasePath = path.join(tempDir, 'data', 'app.sqlite');
  const artifactsRoot = path.join(tempDir, 'artifacts');
  const provider = options.provider ?? 'codex';
  const installCodexStub = options.installCodexStub ?? provider === 'codex';
  const installGeminiStub = options.installGeminiStub ?? provider === 'gemini';
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  if (installCodexStub) {
    await writeStubCodex(path.join(binDir, 'codex'));
  }
  if (installGeminiStub) {
    await writeStubGemini(path.join(binDir, 'gemini'));
  }

  const previousPath = process.env.PATH;
  process.env.PATH = installCodexStub || installGeminiStub
    ? `${binDir}:${previousPath ?? ''}`
    : previousPath ?? '';
  t.after(() => {
    process.env.PATH = previousPath;
  });

  const workspace: WorkspaceConfig = {
    id: 'workspace-1',
    name: 'Workspace',
    rootPath: workspaceDir,
    provider,
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
    artifactsRoot,
  );

  return {
    database,
    service,
    workspace,
    broadcasts,
    artifactsRoot,
  };
}

async function writeStubCodex(filePath: string): Promise<void> {
  const treeHelperProgram = `
const { appendFileSync, writeFileSync } = require('node:fs');
const heartbeatPath = process.env.CODEX_TREE_HEARTBEAT_PATH;
const pidPath = process.env.CODEX_TREE_PID_PATH;
if (pidPath) {
  writeFileSync(pidPath, String(process.pid));
}
setInterval(() => {
  if (heartbeatPath) {
    appendFileSync(heartbeatPath, '.');
  }
}, 100);
`;
  await writeFile(
    filePath,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const execIndex = args.indexOf('exec');
const isResume = execIndex !== -1 && args[execIndex + 1] === 'resume';
const resumeId = isResume ? args[execIndex + 2] : null;
const prompt = args.at(-1) ?? '';

function writeJson(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}

if (prompt.includes('cancel tree')) {
  const helper = spawn(process.execPath, ['-e', ${JSON.stringify(
    treeHelperProgram,
  )}], {
    env: process.env,
    stdio: 'ignore',
  });
  helper.unref();
  writeJson({ type: 'thread.started', thread_id: 'thread-cancel' });
  process.on('SIGINT', () => process.exit(130));
  setInterval(() => {}, 1000);
} else if (prompt.includes('cancel')) {
  writeJson({ type: 'thread.started', thread_id: 'thread-cancel' });
  process.on('SIGINT', () => process.exit(130));
  setInterval(() => {}, 1000);
} else if (prompt.includes('instant fail')) {
  process.exit(17);
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

async function writeStubGemini(filePath: string): Promise<void> {
  const treeHelperProgram = `
const { appendFileSync, writeFileSync } = require('node:fs');
const heartbeatPath = process.env.GEMINI_TREE_HEARTBEAT_PATH;
const pidPath = process.env.GEMINI_TREE_PID_PATH;
if (pidPath) {
  writeFileSync(pidPath, String(process.pid));
}
process.on('SIGINT', () => process.exit(130));
setInterval(() => {
  if (heartbeatPath) {
    appendFileSync(heartbeatPath, '.');
  }
}, 100);
`;
  const ignoreSignalHelperProgram = `
const { writeFileSync } = require('node:fs');
process.on('SIGINT', () => {});
if (process.env.GEMINI_CANCEL_HELPER_READY_PATH) {
  writeFileSync(process.env.GEMINI_CANCEL_HELPER_READY_PATH, 'ready');
}
setTimeout(() => process.exit(0), 500);
`;
  await writeFile(
    filePath,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const promptIndex = args.indexOf('-p');
const resumeIndex = args.indexOf('--resume');
const resumeId =
  resumeIndex !== -1 && resumeIndex + 1 < args.length
    ? args[resumeIndex + 1]
    : null;
const prompt =
  promptIndex !== -1 && promptIndex + 1 < args.length
    ? args[promptIndex + 1]
    : args.at(-1) ?? '';

if (prompt.includes('cancel tree')) {
  const helper = spawn(process.execPath, ['-e', ${JSON.stringify(
    treeHelperProgram,
  )}], {
    env: process.env,
    stdio: 'ignore',
  });
  process.on('SIGINT', () => {});
  helper.on('exit', (code, signal) => {
    if (signal) {
      process.exit(signal === 'SIGKILL' ? 137 : 143);
      return;
    }
    process.exit(code ?? 0);
  });
} else if (prompt.includes('cancel ignored')) {
  const helper = spawn(process.execPath, ['-e', ${JSON.stringify(
    ignoreSignalHelperProgram,
  )}], {
    env: process.env,
    stdio: 'ignore',
  });
  process.on('SIGINT', () => {});
  if (process.env.GEMINI_CANCEL_READY_PATH) {
    writeFileSync(process.env.GEMINI_CANCEL_READY_PATH, 'ready');
  }
  helper.on('exit', (code, signal) => {
    if (signal) {
      process.exit(signal === 'SIGKILL' ? 137 : 143);
      return;
    }
    process.stdout.write('Gemini finished naturally.\\n');
    process.exit(code ?? 0);
  });
} else {
  process.stdout.write(
    resumeId ? 'Gemini resumed ' + resumeId + '.\\n' : 'Gemini finished.\\n'
  );
  process.exit(0);
}
`,
  );
  await chmod(filePath, 0o755);
}
