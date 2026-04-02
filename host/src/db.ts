import { mkdirSync } from 'node:fs';
import path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';

import type {
  RunRecord,
  RunStatus,
  SessionEventRecord,
  SessionRecord,
  SessionStatus,
  WorkspaceConfig,
  WorkspaceRecord,
} from './types.js';
import { createAccessToken, nowIso, sha256 } from './util.js';

type RawSessionRow = {
  id: string;
  workspace_id: string;
  gemini_session_id: string | null;
  transcript_path: string | null;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_run_id: string | null;
};

type RawRunRow = {
  id: string;
  session_id: string;
  status: RunStatus;
  prompt: string;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  cancelled_by_user: number;
  stdout_tail: string | null;
  stderr_tail: string | null;
};

type RawWorkspaceRow = {
  id: string;
  name: string;
  root_path: string;
};

export class AppDatabase {
  readonly db: BetterSqlite3.Database;

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new BetterSqlite3(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_tokens (
        token_hash TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        gemini_session_id TEXT,
        transcript_path TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_id TEXT,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_workspace
      ON sessions(workspace_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        exit_code INTEGER,
        cancelled_by_user INTEGER NOT NULL DEFAULT 0,
        stdout_tail TEXT,
        stderr_tail TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_runs_session
      ON runs(session_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        run_id TEXT,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        ts TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id),
        FOREIGN KEY(run_id) REFERENCES runs(id),
        UNIQUE(session_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_events_session
      ON session_events(session_id, seq ASC);
    `);
  }

  syncWorkspaces(workspaces: WorkspaceConfig[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO workspaces (id, name, root_path)
      VALUES (@id, @name, @rootPath)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        root_path = excluded.root_path
    `);

    const tx = this.db.transaction(() => {
      for (const workspace of workspaces) {
        upsert.run(workspace);
      }
    });

    tx();
  }

  listWorkspaces(
    hookStatusResolver: (rootPath: string) => WorkspaceRecord['hookStatus'],
  ): WorkspaceRecord[] {
    const rows = this.db
      .prepare<[], RawWorkspaceRow>(
        'SELECT id, name, root_path FROM workspaces ORDER BY name ASC',
      )
      .all();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      hookStatus: hookStatusResolver(row.root_path),
    }));
  }

  issueToken(): string {
    const token = createAccessToken();
    this.db
      .prepare(
        'INSERT INTO auth_tokens (token_hash, created_at, last_used_at) VALUES (?, ?, ?)',
      )
      .run(sha256(token), nowIso(), nowIso());
    return token;
  }

  validateToken(token: string): boolean {
    const row = this.db
      .prepare<{ tokenHash: string }, { token_hash: string }>(
        'SELECT token_hash FROM auth_tokens WHERE token_hash = @tokenHash',
      )
      .get({ tokenHash: sha256(token) });

    if (!row) {
      return false;
    }

    this.db
      .prepare('UPDATE auth_tokens SET last_used_at = ? WHERE token_hash = ?')
      .run(nowIso(), row.token_hash);
    return true;
  }

  createSession(id: string, workspaceId: string): SessionRecord {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO sessions
        (id, workspace_id, gemini_session_id, transcript_path, status, created_at, updated_at, last_run_id)
        VALUES (?, ?, NULL, NULL, ?, ?, ?, NULL)`,
      )
      .run(id, workspaceId, 'idle', now, now);

    return this.getSessionOrThrow(id);
  }

  getSessionOrThrow(id: string): SessionRecord {
    const row = this.db
      .prepare<[string], RawSessionRow>(
        `SELECT id, workspace_id, gemini_session_id, transcript_path, status, created_at, updated_at, last_run_id
         FROM sessions WHERE id = ?`,
      )
      .get(id);

    if (!row) {
      throw new Error(`Session not found: ${id}`);
    }

    return mapSession(row);
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db
      .prepare<[string], RawSessionRow>(
        `SELECT id, workspace_id, gemini_session_id, transcript_path, status, created_at, updated_at, last_run_id
         FROM sessions WHERE id = ?`,
      )
      .get(id);
    return row ? mapSession(row) : null;
  }

  listSessions(workspaceId: string): SessionRecord[] {
    const rows = this.db
      .prepare<[string], RawSessionRow>(
        `SELECT id, workspace_id, gemini_session_id, transcript_path, status, created_at, updated_at, last_run_id
         FROM sessions
         WHERE workspace_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(workspaceId);

    return rows.map(mapSession);
  }

  createRun(id: string, sessionId: string, prompt: string): RunRecord {
    const now = nowIso();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO runs
          (id, session_id, status, prompt, started_at, ended_at, exit_code, cancelled_by_user, stdout_tail, stderr_tail)
          VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, '', '')`,
        )
        .run(id, sessionId, 'running', prompt, now);

      this.db
        .prepare(
          'UPDATE sessions SET status = ?, updated_at = ?, last_run_id = ? WHERE id = ?',
        )
        .run('running', now, id, sessionId);
    });

    tx();
    return this.getRunOrThrow(id);
  }

  getRunOrThrow(id: string): RunRecord {
    const row = this.db
      .prepare<[string], RawRunRow>(
        `SELECT id, session_id, status, prompt, started_at, ended_at, exit_code, cancelled_by_user, stdout_tail, stderr_tail
         FROM runs WHERE id = ?`,
      )
      .get(id);

    if (!row) {
      throw new Error(`Run not found: ${id}`);
    }

    return mapRun(row);
  }

  getRun(id: string): RunRecord | null {
    const row = this.db
      .prepare<[string], RawRunRow>(
        `SELECT id, session_id, status, prompt, started_at, ended_at, exit_code, cancelled_by_user, stdout_tail, stderr_tail
         FROM runs WHERE id = ?`,
      )
      .get(id);

    return row ? mapRun(row) : null;
  }

  markRunCancelRequested(runId: string): void {
    this.db
      .prepare('UPDATE runs SET cancelled_by_user = 1 WHERE id = ?')
      .run(runId);
  }

  finishRun(
    runId: string,
    input: {
      status: RunStatus;
      exitCode: number | null;
      stdoutTail: string;
      stderrTail: string;
    },
  ): RunRecord {
    const run = this.getRunOrThrow(runId);
    const now = nowIso();

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE runs
           SET status = ?, ended_at = ?, exit_code = ?, stdout_tail = ?, stderr_tail = ?
           WHERE id = ?`,
        )
        .run(
          input.status,
          now,
          input.exitCode,
          input.stdoutTail,
          input.stderrTail,
          runId,
        );

      const nextSessionStatus: SessionStatus =
        input.status === 'failed'
          ? 'failed'
          : input.status === 'cancelled'
            ? 'cancelled'
            : 'idle';

      this.db
        .prepare(
          'UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?',
        )
        .run(nextSessionStatus, now, run.sessionId);
    });

    tx();
    return this.getRunOrThrow(runId);
  }

  updateSessionMetadata(
    sessionId: string,
    input: {
      geminiSessionId?: string | null;
      transcriptPath?: string | null;
      status?: SessionStatus;
    },
  ): SessionRecord {
    const session = this.getSessionOrThrow(sessionId);
    const next = {
      geminiSessionId:
        input.geminiSessionId === undefined
          ? session.geminiSessionId
          : input.geminiSessionId,
      transcriptPath:
        input.transcriptPath === undefined
          ? session.transcriptPath
          : input.transcriptPath,
      status: input.status ?? session.status,
      updatedAt: nowIso(),
    };

    this.db
      .prepare(
        `UPDATE sessions
         SET gemini_session_id = ?, transcript_path = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.geminiSessionId,
        next.transcriptPath,
        next.status,
        next.updatedAt,
        sessionId,
      );

    return this.getSessionOrThrow(sessionId);
  }

  insertEvent(
    sessionId: string,
    runId: string | null,
    type: string,
    payload: Record<string, unknown>,
    ts = nowIso(),
  ): SessionEventRecord {
    const nextSeq = (
      this.db
        .prepare<[string], { next_seq: number }>(
          'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM session_events WHERE session_id = ?',
        )
        .get(sessionId) ?? { next_seq: 1 }
    ).next_seq;

    this.db
      .prepare(
        `INSERT INTO session_events (session_id, run_id, seq, type, ts, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, runId, nextSeq, type, ts, JSON.stringify(payload));

    this.db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(ts, sessionId);

    return {
      sessionId,
      runId,
      seq: nextSeq,
      type,
      ts,
      payload,
    };
  }

  getEvents(sessionId: string, afterSeq = 0): SessionEventRecord[] {
    const rows = this.db
      .prepare<
        [string, number],
        {
          session_id: string;
          run_id: string | null;
          seq: number;
          type: string;
          ts: string;
          payload_json: string;
        }
      >(
        `SELECT session_id, run_id, seq, type, ts, payload_json
         FROM session_events
         WHERE session_id = ? AND seq > ?
         ORDER BY seq ASC`,
      )
      .all(sessionId, afterSeq);

    return rows.map((row) => ({
      sessionId: row.session_id,
      runId: row.run_id,
      seq: row.seq,
      type: row.type,
      ts: row.ts,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));
  }

  getLatestCompletedMessage(runId: string): SessionEventRecord | null {
    const row = this.db
      .prepare<
        [string],
        {
          session_id: string;
          run_id: string | null;
          seq: number;
          type: string;
          ts: string;
          payload_json: string;
        }
      >(
        `SELECT session_id, run_id, seq, type, ts, payload_json
         FROM session_events
         WHERE run_id = ? AND type = 'message.completed'
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get(runId);

    if (!row) {
      return null;
    }

    return {
      sessionId: row.session_id,
      runId: row.run_id,
      seq: row.seq,
      type: row.type,
      ts: row.ts,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    };
  }
}

function mapSession(row: RawSessionRow): SessionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    geminiSessionId: row.gemini_session_id,
    transcriptPath: row.transcript_path,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunId: row.last_run_id,
  };
}

function mapRun(row: RawRunRow): RunRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    prompt: row.prompt,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    cancelledByUser: row.cancelled_by_user === 1,
    stdoutTail: row.stdout_tail ?? '',
    stderrTail: row.stderr_tail ?? '',
  };
}
