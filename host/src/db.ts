import { mkdirSync } from 'node:fs';
import path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';

import type {
  ArtifactRecord,
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
  model: string | null;
  provider_session_id: string | null;
  gemini_session_id: string | null;
  transcript_path: string | null;
  status: SessionStatus;
  last_message_status: RunStatus | 'idle' | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
  last_run_id: string | null;
  last_prompt: string | null;
};

type RawRunRow = {
  id: string;
  session_id: string;
  model: string | null;
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
  provider: WorkspaceConfig['provider'];
  last_repaired_at: string | null;
};

type RawArtifactRow = {
  id: string;
  session_id: string;
  run_id: string;
  workspace_id: string;
  source_path: string;
  stored_path: string;
  filename: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
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
        root_path TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'gemini',
        last_repaired_at TEXT
      );

      CREATE TABLE IF NOT EXISTS auth_tokens (
        token_hash TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        model TEXT,
        provider_session_id TEXT,
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
        model TEXT,
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

      CREATE TABLE IF NOT EXISTS session_artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id),
        FOREIGN KEY(run_id) REFERENCES runs(id),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_session
      ON session_artifacts(session_id, created_at DESC);
    `);

    this.ensureColumn('workspaces', 'provider', `TEXT NOT NULL DEFAULT 'gemini'`);
    this.ensureColumn('workspaces', 'last_repaired_at', 'TEXT');
    this.ensureColumn('sessions', 'model', 'TEXT');
    this.ensureColumn('sessions', 'provider_session_id', 'TEXT');
    this.ensureColumn('runs', 'model', 'TEXT');
  }

  private ensureColumn(
    tableName: string,
    columnName: string,
    columnDefinition: string,
  ): void {
    const columns = this.db
      .prepare<[], { name: string }>(`PRAGMA table_info(${tableName})`)
      .all();

    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    this.db.exec(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`,
    );
  }

  syncWorkspaces(workspaces: WorkspaceConfig[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO workspaces (id, name, root_path, provider)
      VALUES (@id, @name, @rootPath, @provider)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        root_path = excluded.root_path,
        provider = excluded.provider
    `);

    const tx = this.db.transaction(() => {
      for (const workspace of workspaces) {
        upsert.run(workspace);
      }
    });

    tx();
  }

  listWorkspaces(
    hookStatusResolver: (
      workspace: WorkspaceConfig,
    ) => WorkspaceRecord['hookStatus'],
  ): WorkspaceRecord[] {
    const rows = this.db
      .prepare<[], RawWorkspaceRow>(
        'SELECT id, name, root_path, provider, last_repaired_at FROM workspaces ORDER BY name ASC',
      )
      .all();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      provider: row.provider ?? 'gemini',
      repairedAt: row.last_repaired_at,
      hookStatus: hookStatusResolver({
        id: row.id,
        name: row.name,
        rootPath: row.root_path,
        provider: row.provider ?? 'gemini',
      }),
    }));
  }

  getWorkspace(id: string): WorkspaceRecord | null {
    const row = this.db
      .prepare<[string], RawWorkspaceRow>(
        'SELECT id, name, root_path, provider, last_repaired_at FROM workspaces WHERE id = ?',
      )
      .get(id);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      provider: row.provider ?? 'gemini',
      repairedAt: row.last_repaired_at,
      hookStatus: 'missing',
    };
  }

  listWorkspaceConfigs(): WorkspaceConfig[] {
    const rows = this.db
      .prepare<[], RawWorkspaceRow>(
        'SELECT id, name, root_path, provider, last_repaired_at FROM workspaces ORDER BY name ASC',
      )
      .all();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      provider: row.provider ?? 'gemini',
    }));
  }

  upsertWorkspace(workspace: WorkspaceConfig): WorkspaceRecord {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, root_path, provider)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           root_path = excluded.root_path,
           provider = excluded.provider`,
      )
      .run(
        workspace.id,
        workspace.name,
        workspace.rootPath,
        workspace.provider,
      );

    return this.getWorkspaceOrThrow(workspace.id);
  }

  getWorkspaceOrThrow(id: string): WorkspaceRecord {
    const workspace = this.getWorkspace(id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${id}`);
    }
    return workspace;
  }

  markWorkspaceRepaired(workspaceId: string, repairedAt: string): void {
    this.db
      .prepare(
        'UPDATE workspaces SET last_repaired_at = ? WHERE id = ?',
      )
      .run(repairedAt, workspaceId);
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

  createSession(
    id: string,
    workspaceId: string,
    model: string | null = null,
  ): SessionRecord {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO sessions
        (id, workspace_id, model, provider_session_id, gemini_session_id, transcript_path, status, created_at, updated_at, last_run_id)
        VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL)`,
      )
      .run(id, workspaceId, model, 'idle', now, now);

    return this.getSessionOrThrow(id);
  }

  getSessionOrThrow(id: string): SessionRecord {
    const row = this.db
      .prepare<[string], RawSessionRow>(
        `${sessionSelectSql}
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
        `${sessionSelectSql}
         FROM sessions WHERE id = ?`,
      )
      .get(id);
    return row ? mapSession(row) : null;
  }

  listSessions(workspaceId: string): SessionRecord[] {
    const rows = this.db
      .prepare<[string], RawSessionRow>(
        `${sessionSelectSql}
         FROM sessions
         WHERE workspace_id = ?
         ORDER BY last_activity_at DESC, updated_at DESC`,
      )
      .all(workspaceId);

    return rows.map(mapSession);
  }

  listRuns(sessionId: string): RunRecord[] {
    const rows = this.db
      .prepare<[string], RawRunRow>(
        `SELECT id, session_id, model, status, prompt, started_at, ended_at, exit_code, cancelled_by_user, stdout_tail, stderr_tail
         FROM runs
         WHERE session_id = ?
         ORDER BY started_at DESC, rowid DESC`,
      )
      .all(sessionId);

    return rows.map(mapRun);
  }

  createArtifact(record: ArtifactRecord): ArtifactRecord {
    this.db
      .prepare(
        `INSERT INTO session_artifacts
        (id, session_id, run_id, workspace_id, source_path, stored_path, filename, media_type, size_bytes, sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.runId,
        record.workspaceId,
        record.sourcePath,
        record.storedPath,
        record.filename,
        record.mediaType,
        record.sizeBytes,
        record.sha256,
        record.createdAt,
      );

    return this.getArtifactOrThrow(record.id);
  }

  getArtifact(id: string): ArtifactRecord | null {
    const row = this.db
      .prepare<[string], RawArtifactRow>(
        `SELECT id, session_id, run_id, workspace_id, source_path, stored_path, filename, media_type, size_bytes, sha256, created_at
         FROM session_artifacts
         WHERE id = ?`,
      )
      .get(id);

    return row ? mapArtifact(row) : null;
  }

  getArtifactOrThrow(id: string): ArtifactRecord {
    const artifact = this.getArtifact(id);
    if (!artifact) {
      throw new Error(`Artifact not found: ${id}`);
    }
    return artifact;
  }

  listArtifacts(sessionId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare<[string], RawArtifactRow>(
        `SELECT id, session_id, run_id, workspace_id, source_path, stored_path, filename, media_type, size_bytes, sha256, created_at
         FROM session_artifacts
         WHERE session_id = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(sessionId);

    return rows.map(mapArtifact);
  }

  deleteSession(sessionId: string): ArtifactRecord[] {
    const artifacts = this.listArtifacts(sessionId);
    const tx = this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM session_events WHERE session_id = ?')
        .run(sessionId);
      this.db
        .prepare('DELETE FROM session_artifacts WHERE session_id = ?')
        .run(sessionId);
      this.db
        .prepare('DELETE FROM runs WHERE session_id = ?')
        .run(sessionId);
      this.db
        .prepare('DELETE FROM sessions WHERE id = ?')
        .run(sessionId);
    });
    tx();
    return artifacts;
  }

  recoverOrphanedRuns(reason: string): Array<{
    sessionId: string;
    runId: string;
  }> {
    const runningRuns = this.db
      .prepare<
        [],
        {
          id: string;
          session_id: string;
          stdout_tail: string | null;
          stderr_tail: string | null;
        }
      >(
        `SELECT id, session_id, stdout_tail, stderr_tail
         FROM runs
         WHERE status = 'running'
         ORDER BY started_at ASC, rowid ASC`,
      )
      .all();

    if (runningRuns.length === 0) {
      return [];
    }

    const recoveredAt = nowIso();
    const recovered: Array<{ sessionId: string; runId: string }> = [];
    const tx = this.db.transaction(() => {
      for (const run of runningRuns) {
        const stderrTail = [run.stderr_tail?.trim(), reason]
          .filter((value): value is string => value != null && value.length > 0)
          .join('\n');

        this.db
          .prepare(
            `UPDATE runs
             SET status = 'failed', ended_at = ?, exit_code = NULL, stderr_tail = ?
             WHERE id = ?`,
          )
          .run(recoveredAt, stderrTail, run.id);

        this.db
          .prepare(
            `UPDATE sessions
             SET status = 'failed', updated_at = ?
             WHERE id = ?`,
          )
          .run(recoveredAt, run.session_id);

        this.insertEvent(
          run.session_id,
          run.id,
          'run.failed',
          {
            exitCode: null,
            signal: 'startup-recovery',
            stdoutTail: run.stdout_tail ?? '',
            stderrTail,
            recovered: true,
          },
          recoveredAt,
        );

        recovered.push({
          sessionId: run.session_id,
          runId: run.id,
        });
      }
    });

    tx();
    return recovered;
  }

  createRun(
    id: string,
    sessionId: string,
    prompt: string,
    model: string | null = null,
  ): RunRecord {
    const now = nowIso();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO runs
          (id, session_id, model, status, prompt, started_at, ended_at, exit_code, cancelled_by_user, stdout_tail, stderr_tail)
          VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, '', '')`,
        )
        .run(id, sessionId, model, 'running', prompt, now);

      this.db
        .prepare(
          'UPDATE sessions SET model = ?, status = ?, updated_at = ?, last_run_id = ? WHERE id = ?',
        )
        .run(model, 'running', now, id, sessionId);
    });

    tx();
    return this.getRunOrThrow(id);
  }

  getRunOrThrow(id: string): RunRecord {
    const row = this.db
      .prepare<[string], RawRunRow>(
        `SELECT id, session_id, model, status, prompt, started_at, ended_at, exit_code, cancelled_by_user, stdout_tail, stderr_tail
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
        `SELECT id, session_id, model, status, prompt, started_at, ended_at, exit_code, cancelled_by_user, stdout_tail, stderr_tail
         FROM runs WHERE id = ?`,
      )
      .get(id);

    return row ? mapRun(row) : null;
  }

  finishRun(
    runId: string,
    input: {
      status: RunStatus;
      exitCode: number | null;
      stdoutTail: string;
      stderrTail: string;
      cancelledByUser?: boolean;
    },
  ): RunRecord {
    const run = this.getRunOrThrow(runId);
    const now = nowIso();
    const cancelledByUser = input.cancelledByUser ?? run.cancelledByUser;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE runs
           SET status = ?, ended_at = ?, exit_code = ?, cancelled_by_user = ?, stdout_tail = ?, stderr_tail = ?
           WHERE id = ?`,
        )
        .run(
          input.status,
          now,
          input.exitCode,
          cancelledByUser ? 1 : 0,
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
      model?: string | null;
      providerSessionId?: string | null;
      geminiSessionId?: string | null;
      transcriptPath?: string | null;
      status?: SessionStatus;
    },
  ): SessionRecord {
    const session = this.getSessionOrThrow(sessionId);
    const next = {
      model:
        input.model === undefined ? session.model : input.model,
      providerSessionId:
        input.providerSessionId === undefined
          ? session.providerSessionId
          : input.providerSessionId,
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
         SET model = ?, provider_session_id = ?, gemini_session_id = ?, transcript_path = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.model,
        next.providerSessionId,
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
    model: row.model,
    providerSessionId: row.provider_session_id ?? row.gemini_session_id,
    geminiSessionId: row.gemini_session_id,
    transcriptPath: row.transcript_path,
    status: row.status,
    lastMessageStatus: row.last_message_status ?? inferMessageStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at ?? row.updated_at,
    lastRunId: row.last_run_id,
    lastPrompt: row.last_prompt,
  };
}

function mapArtifact(row: RawArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    sourcePath: row.source_path,
    storedPath: row.stored_path,
    filename: row.filename,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

const sessionSelectSql = `
  SELECT
    id,
    workspace_id,
    model,
    provider_session_id,
    gemini_session_id,
    transcript_path,
    status,
    CASE
      WHEN status = 'running' THEN 'running'
      WHEN status = 'failed' THEN 'failed'
      WHEN status = 'cancelled' THEN 'cancelled'
      ELSE COALESCE(
        (
          SELECT CASE
            WHEN type = 'run.failed' THEN 'failed'
            WHEN type = 'run.cancelled' THEN 'cancelled'
            WHEN type = 'run.completed' THEN 'completed'
            WHEN type = 'message.completed' THEN 'completed'
            ELSE NULL
          END
          FROM session_events
          WHERE session_id = sessions.id
            AND type IN (
              'run.failed',
              'run.cancelled',
              'run.completed',
              'message.completed'
            )
          ORDER BY seq DESC
          LIMIT 1
        ),
        CASE
          WHEN last_run_id IS NULL THEN 'idle'
          ELSE 'completed'
        END
      )
    END AS last_message_status,
    created_at,
    updated_at,
    COALESCE(
      (
        SELECT ts
        FROM session_events
        WHERE session_id = sessions.id
        ORDER BY seq DESC
        LIMIT 1
      ),
      updated_at
    ) AS last_activity_at,
    last_run_id,
    (
      SELECT prompt
      FROM runs
      WHERE id = sessions.last_run_id
      LIMIT 1
    ) AS last_prompt
`;

function inferMessageStatus(status: SessionStatus): RunStatus | 'idle' {
  switch (status) {
    case 'running':
      return 'running';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'idle':
    default:
      return 'idle';
  }
}

function mapRun(row: RawRunRow): RunRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    model: row.model,
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
