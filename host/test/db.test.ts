import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import BetterSqlite3 from 'better-sqlite3';

import { AppDatabase } from '../src/db.js';
import { cleanupTempDir, makeTempDir } from './testUtils.js';

test('AppDatabase migrates legacy rows and falls back to gemini_session_id', async (t) => {
  const tempDir = await makeTempDir('gemini-remote-db-');
  t.after(async () => {
    await cleanupTempDir(tempDir);
  });

  const dbPath = path.join(tempDir, 'data', 'app.sqlite');
  await mkdir(path.dirname(dbPath), { recursive: true });

  const legacyDb = new BetterSqlite3(dbPath);
  legacyDb.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL
    );

    CREATE TABLE auth_tokens (
      token_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      gemini_session_id TEXT,
      transcript_path TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_run_id TEXT
    );

    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      exit_code INTEGER,
      cancelled_by_user INTEGER NOT NULL DEFAULT 0,
      stdout_tail TEXT,
      stderr_tail TEXT
    );

    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      run_id TEXT,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      ts TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);

  legacyDb
    .prepare('INSERT INTO workspaces (id, name, root_path) VALUES (?, ?, ?)')
    .run('legacy-workspace', 'Legacy Workspace', '/tmp/legacy');
  legacyDb
    .prepare(
      `INSERT INTO sessions
      (id, workspace_id, gemini_session_id, transcript_path, status, created_at, updated_at, last_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'session-1',
      'legacy-workspace',
      'legacy-gemini-session',
      null,
      'idle',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      null,
    );
  legacyDb.close();

  const database = new AppDatabase(dbPath);
  t.after(() => {
    database.close();
  });

  database.syncWorkspaces([
    {
      id: 'legacy-workspace',
      name: 'Legacy Workspace',
      rootPath: '/tmp/legacy',
      provider: 'codex',
    },
  ]);

  const session = database.getSessionOrThrow('session-1');
  const workspaces = database.listWorkspaces(() => 'installed');

  assert.equal(session.providerSessionId, 'legacy-gemini-session');
  assert.equal(session.geminiSessionId, 'legacy-gemini-session');
  assert.equal(workspaces[0]?.provider, 'codex');
});

test('AppDatabase lists session runs in reverse chronological order with diagnostics', async (t) => {
  const tempDir = await makeTempDir('gemini-remote-db-runs-');
  t.after(async () => {
    await cleanupTempDir(tempDir);
  });

  const dbPath = path.join(tempDir, 'data', 'app.sqlite');
  await mkdir(path.dirname(dbPath), { recursive: true });

  const database = new AppDatabase(dbPath);
  t.after(() => {
    database.close();
  });

  database.syncWorkspaces([
    {
      id: 'workspace-1',
      name: 'Workspace',
      rootPath: '/tmp/workspace-1',
      provider: 'gemini',
    },
  ]);
  database.markWorkspaceRepaired('workspace-1', '2026-02-02T00:00:00.000Z');

  const session = database.createSession('session-1', 'workspace-1');
  const firstRun = database.createRun(
    'run-1',
    session.id,
    'first prompt',
    'gemini-2.5-pro',
  );
  database.finishRun(firstRun.id, {
    status: 'completed',
    exitCode: 0,
    stdoutTail: 'first stdout',
    stderrTail: '',
  });

  const secondRun = database.createRun(
    'run-2',
    session.id,
    'second prompt',
    'gemini-2.5-flash',
  );
  database.finishRun(secondRun.id, {
    status: 'failed',
    exitCode: 2,
    stdoutTail: '',
    stderrTail: 'second stderr',
  });

  const runs = database.listRuns(session.id);
  const sessionSummary = database.listSessions('workspace-1')[0];
  const workspaces = database.listWorkspaces(() => 'installed');

  assert.deepEqual(
    runs.map((run) => run.id),
    ['run-2', 'run-1'],
  );
  assert.equal(runs[0]?.model, 'gemini-2.5-flash');
  assert.equal(runs[0]?.stderrTail, 'second stderr');
  assert.equal(runs[0]?.exitCode, 2);
  assert.equal(runs[1]?.model, 'gemini-2.5-pro');
  assert.equal(runs[1]?.stdoutTail, 'first stdout');
  assert.equal(runs[1]?.status, 'completed');
  assert.equal(sessionSummary?.lastPrompt, 'second prompt');
  assert.equal(database.getSessionOrThrow(session.id).model, 'gemini-2.5-flash');
  assert.equal(workspaces[0]?.repairedAt, '2026-02-02T00:00:00.000Z');
});

test('AppDatabase keeps a running session summary active after message completion', async (t) => {
  const tempDir = await makeTempDir('gemini-remote-db-session-status-');
  t.after(async () => {
    await cleanupTempDir(tempDir);
  });

  const dbPath = path.join(tempDir, 'data', 'app.sqlite');
  await mkdir(path.dirname(dbPath), { recursive: true });

  const database = new AppDatabase(dbPath);
  t.after(() => {
    database.close();
  });

  database.syncWorkspaces([
    {
      id: 'workspace-1',
      name: 'Workspace',
      rootPath: '/tmp/workspace-1',
      provider: 'codex',
    },
  ]);

  const session = database.createSession('session-1', 'workspace-1');
  const run = database.createRun('run-1', session.id, 'tool prompt');
  database.insertEvent(session.id, run.id, 'run.started', {}, '2026-02-02T00:00:00.000Z');
  database.insertEvent(
    session.id,
    run.id,
    'message.completed',
    { text: 'Working on it.' },
    '2026-02-02T00:00:01.000Z',
  );

  const runningSession = database.listSessions('workspace-1')[0];
  assert.equal(runningSession?.status, 'running');
  assert.equal(runningSession?.lastMessageStatus, 'running');

  database.finishRun(run.id, {
    status: 'completed',
    exitCode: 0,
    stdoutTail: '',
    stderrTail: '',
  });

  const completedSession = database.listSessions('workspace-1')[0];
  assert.equal(completedSession?.status, 'idle');
  assert.equal(completedSession?.lastMessageStatus, 'completed');
});

test('AppDatabase upserts custom workspaces and reloads them as runnable configs', async (t) => {
  const tempDir = await makeTempDir('gemini-remote-db-workspaces-');
  t.after(async () => {
    await cleanupTempDir(tempDir);
  });

  const dbPath = path.join(tempDir, 'data', 'app.sqlite');
  await mkdir(path.dirname(dbPath), { recursive: true });

  const database = new AppDatabase(dbPath);
  t.after(() => {
    database.close();
  });

  database.upsertWorkspace({
    id: 'custom-codex',
    name: 'Custom Codex',
    rootPath: '/tmp/custom-codex',
    provider: 'codex',
  });
  database.markWorkspaceRepaired('custom-codex', '2026-03-03T00:00:00.000Z');

  const stored = database.getWorkspaceOrThrow('custom-codex');
  const configs = database.listWorkspaceConfigs();

  assert.equal(stored.rootPath, '/tmp/custom-codex');
  assert.equal(stored.provider, 'codex');
  assert.equal(stored.repairedAt, '2026-03-03T00:00:00.000Z');
  assert.deepEqual(configs, [
    {
      id: 'custom-codex',
      name: 'Custom Codex',
      rootPath: '/tmp/custom-codex',
      provider: 'codex',
    },
  ]);
});

test('AppDatabase stores shared artifacts in reverse chronological order', async (t) => {
  const tempDir = await makeTempDir('gemini-remote-db-artifacts-');
  t.after(async () => {
    await cleanupTempDir(tempDir);
  });

  const dbPath = path.join(tempDir, 'data', 'app.sqlite');
  await mkdir(path.dirname(dbPath), { recursive: true });

  const database = new AppDatabase(dbPath);
  t.after(() => {
    database.close();
  });

  database.syncWorkspaces([
    {
      id: 'workspace-1',
      name: 'Workspace',
      rootPath: '/tmp/workspace-1',
      provider: 'gemini',
    },
  ]);

  const session = database.createSession('session-1', 'workspace-1');
  const run = database.createRun('run-1', session.id, 'share file');
  database.createArtifact({
    id: 'artifact-1',
    sessionId: session.id,
    runId: run.id,
    workspaceId: 'workspace-1',
    sourcePath: 'build/a.json',
    storedPath: '/tmp/artifacts/a.json',
    filename: 'a.json',
    mediaType: 'application/json',
    sizeBytes: 12,
    sha256: 'hash-a',
    createdAt: '2026-03-01T00:00:00.000Z',
  });
  database.createArtifact({
    id: 'artifact-2',
    sessionId: session.id,
    runId: run.id,
    workspaceId: 'workspace-1',
    sourcePath: 'build/b.json',
    storedPath: '/tmp/artifacts/b.json',
    filename: 'b.json',
    mediaType: 'application/json',
    sizeBytes: 21,
    sha256: 'hash-b',
    createdAt: '2026-03-01T00:00:01.000Z',
  });

  const artifacts = database.listArtifacts(session.id);

  assert.deepEqual(
    artifacts.map((artifact) => artifact.id),
    ['artifact-2', 'artifact-1'],
  );
  assert.equal(artifacts[0]?.sourcePath, 'build/b.json');
  assert.equal(artifacts[1]?.filename, 'a.json');
});

test('AppDatabase deletes a session and all dependent rows', async (t) => {
  const tempDir = await makeTempDir('gemini-remote-db-delete-session-');
  t.after(async () => {
    await cleanupTempDir(tempDir);
  });

  const dbPath = path.join(tempDir, 'data', 'app.sqlite');
  await mkdir(path.dirname(dbPath), { recursive: true });

  const database = new AppDatabase(dbPath);
  t.after(() => {
    database.close();
  });

  database.syncWorkspaces([
    {
      id: 'workspace-1',
      name: 'Workspace',
      rootPath: '/tmp/workspace-1',
      provider: 'codex',
    },
  ]);

  const session = database.createSession('session-1', 'workspace-1');
  const run = database.createRun('run-1', session.id, 'delete me');
  database.insertEvent(session.id, run.id, 'run.started', {});
  database.createArtifact({
    id: 'artifact-1',
    sessionId: session.id,
    runId: run.id,
    workspaceId: 'workspace-1',
    sourcePath: 'build/result.txt',
    storedPath: '/tmp/artifacts/result.txt',
    filename: 'result.txt',
    mediaType: 'text/plain',
    sizeBytes: 7,
    sha256: 'hash-1',
    createdAt: '2026-03-01T00:00:00.000Z',
  });

  const deletedArtifacts = database.deleteSession(session.id);

  assert.equal(deletedArtifacts.length, 1);
  assert.equal(database.getSession(session.id), null);
  assert.deepEqual(database.listRuns(session.id), []);
  assert.deepEqual(database.getEvents(session.id), []);
  assert.deepEqual(database.listArtifacts(session.id), []);
});

test('AppDatabase recovers orphaned running runs on daemon startup', async (t) => {
  const tempDir = await makeTempDir('gemini-remote-db-recover-');
  t.after(async () => {
    await cleanupTempDir(tempDir);
  });

  const dbPath = path.join(tempDir, 'data', 'app.sqlite');
  await mkdir(path.dirname(dbPath), { recursive: true });

  const database = new AppDatabase(dbPath);
  t.after(() => {
    database.close();
  });

  database.syncWorkspaces([
    {
      id: 'workspace-1',
      name: 'Workspace',
      rootPath: '/tmp/workspace-1',
      provider: 'codex',
    },
  ]);

  const session = database.createSession('session-1', 'workspace-1');
  const run = database.createRun('run-1', session.id, 'stuck prompt');

  const recovered = database.recoverOrphanedRuns(
    'Recovered from startup.',
  );
  const recoveredRun = database.getRunOrThrow(run.id);
  const recoveredSession = database.getSessionOrThrow(session.id);
  const events = database.getEvents(session.id);

  assert.deepEqual(recovered, [{ sessionId: session.id, runId: run.id }]);
  assert.equal(recoveredRun.status, 'failed');
  assert.equal(recoveredSession.status, 'failed');
  assert.match(recoveredRun.stderrTail, /Recovered from startup\./);
  assert.ok(
    events.some(
      (event) =>
        event.type == 'run.failed' &&
        event.runId == run.id &&
        event.payload.recovered == true,
    ),
  );
});
