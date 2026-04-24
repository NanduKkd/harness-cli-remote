import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

import { AppDatabase } from './db.js';
import { ClaudeRunner } from './claudeRunner.js';
import { CodexRunner } from './codexRunner.js';
import { GeminiRunner, recoverGeminiSessionMetadata } from './geminiRunner.js';
import { viewSessionEvent } from './sessionEvents.js';
import type { RunnerControls, RuntimeRun, WorkspaceRunner } from './runners.js';
import type {
  ArtifactRecord,
  ArtifactRegistrationBody,
  ArtifactViewRecord,
  BroadcastEnvelope,
  HookIngressBody,
  RunRecord,
  SessionEventRecord,
  SessionRecord,
  WorkspaceConfig,
  WorkspaceProvider,
} from './types.js';
import { clampText, guessMimeType, isSubPath, nowIso, sanitizeFilename, sha256 } from './util.js';

type BroadcastFn = (envelope: BroadcastEnvelope) => void;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
export type DeleteSessionOutcome =
  | 'deleted'
  | 'not_found'
  | 'active'
  | 'not_allowed';

export class SessionServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'SessionServiceError';
  }
}

export class SessionService {
  private readonly runtimesBySession = new Map<string, RuntimeRun>();
  private readonly runtimesByHookToken = new Map<string, RuntimeRun>();
  private readonly runners = new Map<WorkspaceProvider, WorkspaceRunner>([
    ['gemini', new GeminiRunner()],
    ['codex', new CodexRunner()],
    ['claude', new ClaudeRunner()],
  ]);
  private readonly controls: RunnerControls;

  constructor(
    private readonly database: AppDatabase,
    private readonly workspaces: Map<string, WorkspaceConfig>,
    private readonly daemonUrl: string,
    private readonly logger: FastifyBaseLogger,
    private readonly broadcast: BroadcastFn,
    private readonly artifactsRoot: string,
  ) {
    this.controls = {
      emit: (sessionId, runId, event) => this.emit(sessionId, runId, event),
      updateSessionMetadata: (sessionId, input) =>
        this.database.updateSessionMetadata(sessionId, input),
      getSession: (sessionId) => this.database.getSession(sessionId),
      getRun: (runId) => this.database.getRun(runId),
      getLatestCompletedMessage: (runId) =>
        this.database.getLatestCompletedMessage(runId),
      logger: this.logger,
    };
  }

  createSession(
    workspaceId: string,
    prompt: string,
    model?: string | null,
  ): SessionRecord {
    const workspace = this.requireWorkspace(workspaceId);
    const session = this.database.createSession(
      randomUUID(),
      workspace.id,
      model ?? null,
    );
    this.startRun(session, workspace, prompt, false, session.model);
    return this.database.getSessionOrThrow(session.id);
  }

  sendPrompt(
    sessionId: string,
    prompt: string,
    model?: string | null,
  ): SessionRecord {
    let session = this.requireSession(sessionId);
    const workspace = this.requireWorkspace(session.workspaceId);

    if (this.runtimesBySession.has(session.id)) {
      throw new SessionServiceError('Session already has an active run.', 409);
    }

    if (!session.providerSessionId && workspace.provider === 'gemini') {
      session = this.tryRecoverGeminiSessionMetadata(session);
    }

    if (!session.providerSessionId) {
      const providerLabel = providerDisplayName(workspace.provider);
      throw new SessionServiceError(
        `This session cannot be resumed because ${providerLabel} did not persist a session id. Repair the workspace hooks and start a new session.`,
        409,
      );
    }

    this.startRun(session, workspace, prompt, true, model ?? session.model);
    return this.database.getSessionOrThrow(session.id);
  }

  reconcileDetachedRuns(workspaceId: string): void {
    for (const session of this.database.listSessions(workspaceId)) {
      this.reconcileDetachedSession(session.id);
    }
  }

  reconcileDetachedSession(sessionId: string): boolean {
    return this.finishDetachedRun(
      sessionId,
      'failed',
      'The host lost track of this run before it finished. Start a new session or resend the prompt.',
    );
  }

  cancelSession(sessionId: string): boolean {
    const runtime = this.runtimesBySession.get(sessionId);
    if (!runtime) {
      return this.finishDetachedRun(
        sessionId,
        'cancelled',
        'The host lost track of this run before it finished. It was cancelled from the mobile app.',
      );
    }

    if (runtime.cancelRequestedByUser) {
      return true;
    }

    runtime.cancelRequestedByUser = true;
    runtime.sendSignal('SIGINT');
    runtime.cancelTimer = setTimeout(() => {
      runtime.sendSignal('SIGKILL');
    }, 3000);

    return true;
  }

  deleteSession(sessionId: string): DeleteSessionOutcome {
    if (this.runtimesBySession.has(sessionId)) {
      return 'active';
    }

    const session = this.database.getSession(sessionId);
    if (!session) {
      return 'not_found';
    }

    if (session.status === 'running') {
      return 'active';
    }

    if (
      session.lastMessageStatus !== 'completed' &&
      session.lastMessageStatus !== 'cancelled'
    ) {
      return 'not_allowed';
    }

    const artifacts = this.database.deleteSession(sessionId);
    for (const artifact of artifacts) {
      const artifactDir = path.dirname(artifact.storedPath);
      if (!isSubPath(this.artifactsRoot, artifactDir)) {
        this.logger.warn(
          {
            sessionId,
            artifactId: artifact.id,
            artifactDir,
            artifactsRoot: this.artifactsRoot,
          },
          'Skipped artifact directory cleanup outside configured artifacts root',
        );
        continue;
      }

      try {
        rmSync(artifactDir, { recursive: true, force: true });
      } catch (error) {
        this.logger.warn(
          {
            err: error,
            sessionId,
            artifactId: artifact.id,
            artifactDir,
          },
          'Failed to clean up deleted session artifact directory',
        );
      }
    }

    return 'deleted';
  }

  handleHookIngress(token: string, body: HookIngressBody): SessionEventRecord[] {
    const runtime = this.runtimesByHookToken.get(token);
    if (!runtime) {
      throw new Error('Unknown hook token.');
    }

    if (
      runtime.sessionId !== body.remoteSessionId ||
      runtime.runId !== body.remoteRunId
    ) {
      throw new Error('Hook payload does not match active run.');
    }

    return runtime.runner.handleHookIngress?.(runtime, body, this.controls) ?? [];
  }

  registerArtifact(
    token: string,
    body: ArtifactRegistrationBody,
  ): ArtifactViewRecord {
    const runtime = this.runtimesByHookToken.get(token);
    if (!runtime) {
      throw new Error('Unknown hook token.');
    }

    if (
      runtime.sessionId !== body.remoteSessionId ||
      runtime.runId !== body.remoteRunId
    ) {
      throw new Error('Artifact payload does not match active run.');
    }

    const resolved = resolveArtifactPath(runtime.workspace.rootPath, body.path);
    const stats = statSync(resolved.absolutePath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${body.path}`);
    }
    if (stats.size > MAX_ARTIFACT_BYTES) {
      throw new Error(
        `File exceeds the ${Math.round(MAX_ARTIFACT_BYTES / (1024 * 1024))} MB artifact limit.`,
      );
    }

    const artifactId = randomUUID();
    const filename = sanitizeFilename(
      body.title?.trim() || path.basename(resolved.absolutePath),
    );
    const artifactDir = path.join(this.artifactsRoot, artifactId);
    const storedPath = path.join(artifactDir, filename);
    mkdirSync(artifactDir, { recursive: true });
    copyFileSync(resolved.absolutePath, storedPath);

    const created = this.database.createArtifact({
      id: artifactId,
      sessionId: runtime.sessionId,
      runId: runtime.runId,
      workspaceId: runtime.workspace.id,
      sourcePath: resolved.relativePath,
      storedPath,
      filename,
      mediaType: body.mimeType?.trim() || guessMimeType(filename),
      sizeBytes: stats.size,
      sha256: sha256(readFileSync(storedPath)),
      createdAt: body.requestedAt,
    });

    const view = toArtifactView(created);
    this.emit(runtime.sessionId, runtime.runId, {
      type: 'artifact.shared',
      payload: {
        artifactId: view.id,
        title: view.filename,
        filename: view.filename,
        path: view.sourcePath,
        mimeType: view.mediaType,
        sizeBytes: view.sizeBytes,
        downloadPath: view.downloadPath,
      },
      ts: view.createdAt,
    });

    return view;
  }

  listArtifacts(sessionId: string): ArtifactViewRecord[] {
    return this.database.listArtifacts(sessionId).map(toArtifactView);
  }

  getArtifactRecord(id: string): ArtifactRecord | null {
    return this.database.getArtifact(id);
  }

  private startRun(
    session: SessionRecord,
    workspace: WorkspaceConfig,
    prompt: string,
    resume: boolean,
    model: string | null,
  ): void {
    const run = this.database.createRun(randomUUID(), session.id, prompt, model);
    const hookToken = randomUUID();
    const runner = this.requireRunner(workspace.provider);
    const { child, state, sendSignal } = runner.spawnRun({
      session,
      workspace,
      model,
      prompt,
      resume,
      daemonUrl: this.daemonUrl,
      hookToken,
      runId: run.id,
      logger: this.logger,
    });

    const runtime: RuntimeRun = {
      child,
      runId: run.id,
      sessionId: session.id,
      workspace,
      hookToken,
      stdoutTail: '',
      stderrTail: '',
      cancelTimer: null,
      cancelRequestedByUser: false,
      sendSignal:
        sendSignal ??
        ((signal) => {
          child.kill(signal);
        }),
      runner,
      state,
    };

    this.runtimesBySession.set(session.id, runtime);
    this.runtimesByHookToken.set(hookToken, runtime);

    let finalized = false;
    const finalizeOnce = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finalized) {
        return;
      }
      finalized = true;

      if (runtime.cancelTimer) {
        clearTimeout(runtime.cancelTimer);
      }

      this.finalizeRun(runtime, run, code, signal);
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      runtime.stdoutTail = clampText(`${runtime.stdoutTail}${text}`, 4000);
      runtime.runner.handleStdoutChunk?.(runtime, text, this.controls);
    });

    child.stderr.on('data', (chunk) => {
      runtime.stderrTail = clampText(
        `${runtime.stderrTail}${chunk.toString()}`,
        4000,
      );
    });

    child.on('error', (error) => {
      const message = formatSpawnError(workspace.provider, error);
      runtime.stderrTail = clampText(
        `${runtime.stderrTail}\n${message}`.trim(),
        4000,
      );
    });

    child.on('close', (code, signal) => {
      finalizeOnce(code, signal);
    });

    // Prompts are passed as CLI arguments; close stdin so providers do not
    // wait for additional interactive input from the host process.
    child.stdin.end();

    this.emit(session.id, run.id, {
      type: 'run.started',
      payload: {
        model,
        prompt,
        resume,
        workspaceId: workspace.id,
        provider: workspace.provider,
      },
      ts: run.startedAt,
    });

    if (child.exitCode !== null || child.signalCode !== null) {
      finalizeOnce(child.exitCode, child.signalCode);
    }
  }

  private finalizeRun(
    runtime: RuntimeRun,
    run: RunRecord,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.runtimesBySession.delete(runtime.sessionId);
    this.runtimesByHookToken.delete(runtime.hookToken);

    let stdoutTail = runtime.stdoutTail;
    let stderrTail = runtime.stderrTail;

    const latestRun = this.database.getRunOrThrow(run.id);
    const cancelled = isCancellationExit(code, signal);
    let status: RunRecord['status'] =
      cancelled ? 'cancelled' : code === 0 ? 'completed' : 'failed';

    const finalization = runtime.runner.finalize?.(
      runtime,
      run,
      code,
      signal,
      this.controls,
    );

    if (finalization?.stdoutTail !== undefined) {
      stdoutTail = finalization.stdoutTail;
    }
    if (finalization?.stderrTail !== undefined) {
      stderrTail = finalization.stderrTail;
    }
    if (finalization?.status) {
      status = finalization.status;
    }

    const finishedRun = this.database.finishRun(run.id, {
      status,
      exitCode: code,
      cancelledByUser: status === 'cancelled' && runtime.cancelRequestedByUser,
      stdoutTail,
      stderrTail,
    });

    this.emitRunTerminalEvent(
      runtime.sessionId,
      run.id,
      finishedRun.status,
      code,
      signal,
      stdoutTail,
      stderrTail,
    );
  }

  private emit(
    sessionId: string,
    runId: string | null,
    event: {
      type: string;
      payload: Record<string, unknown>;
      ts: string;
    },
  ): SessionEventRecord {
    const inserted = this.database.insertEvent(
      sessionId,
      runId,
      event.type,
      event.payload,
      event.ts,
    );
    const session = this.database.getSessionOrThrow(sessionId);
    this.broadcast({
      type: 'session.event',
      sessionId,
      workspaceId: session.workspaceId,
      event: viewSessionEvent(inserted, 'summary'),
    });
    return inserted;
  }

  private finishDetachedRun(
    sessionId: string,
    status: RunRecord['status'],
    fallbackStderrTail: string,
  ): boolean {
    if (this.runtimesBySession.has(sessionId)) {
      return false;
    }

    const session = this.database.getSession(sessionId);
    if (!session || session.status !== 'running' || !session.lastRunId) {
      return false;
    }

    const run = this.database.getRun(session.lastRunId);
    if (!run || run.status !== 'running') {
      return false;
    }

    const stdoutTail = run.stdoutTail;
    const stderrTail = run.stderrTail || fallbackStderrTail;
    const finishedRun = this.database.finishRun(run.id, {
      status,
      exitCode: run.exitCode,
      cancelledByUser: status === 'cancelled',
      stdoutTail,
      stderrTail,
    });

    this.emitRunTerminalEvent(
      sessionId,
      run.id,
      finishedRun.status,
      run.exitCode,
      null,
      stdoutTail,
      stderrTail,
      {
        recovered: true,
      },
    );

    return true;
  }

  private emitRunTerminalEvent(
    sessionId: string,
    runId: string,
    status: RunRecord['status'],
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stdoutTail: string,
    stderrTail: string,
    extraPayload: Record<string, unknown> = {},
  ): void {
    const eventType =
      status === 'cancelled'
        ? 'run.cancelled'
        : status === 'failed'
          ? 'run.failed'
          : 'run.completed';

    this.emit(sessionId, runId, {
      type: eventType,
      payload: {
        exitCode,
        signal,
        stdoutTail,
        stderrTail,
        ...extraPayload,
      },
      ts: nowIso(),
    });
  }

  private requireRunner(provider: WorkspaceProvider): WorkspaceRunner {
    const runner = this.runners.get(provider);
    if (!runner) {
      throw new Error(`Unsupported workspace provider: ${provider}`);
    }
    return runner;
  }

  private requireWorkspace(id: string): WorkspaceConfig {
    const workspace = this.workspaces.get(id);
    if (!workspace) {
      throw new SessionServiceError(`Unknown workspace: ${id}`, 404);
    }
    return workspace;
  }

  private requireSession(id: string): SessionRecord {
    const session = this.database.getSession(id);
    if (!session) {
      throw new SessionServiceError(`Unknown session: ${id}`, 404);
    }
    return session;
  }

  private tryRecoverGeminiSessionMetadata(session: SessionRecord): SessionRecord {
    const recovered = recoverGeminiSessionMetadata(session, this.logger);
    if (!recovered) {
      return session;
    }

    if (
      recovered.providerSessionId === session.providerSessionId &&
      recovered.geminiSessionId === session.geminiSessionId &&
      recovered.transcriptPath === session.transcriptPath
    ) {
      return session;
    }

    return this.database.updateSessionMetadata(session.id, recovered);
  }
}

function isCancellationExit(
  code: number | null,
  signal: NodeJS.Signals | null,
): boolean {
  return (
    signal === 'SIGINT' ||
    signal === 'SIGKILL' ||
    signal === 'SIGTERM' ||
    code === 130 ||
    code === 137 ||
    code === 143
  );
}

function toArtifactView(artifact: ArtifactRecord): ArtifactViewRecord {
  return {
    id: artifact.id,
    sessionId: artifact.sessionId,
    runId: artifact.runId,
    workspaceId: artifact.workspaceId,
    sourcePath: artifact.sourcePath,
    filename: artifact.filename,
    mediaType: artifact.mediaType,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    createdAt: artifact.createdAt,
    downloadPath: `/artifacts/${artifact.id}/download`,
  };
}

function resolveArtifactPath(
  workspaceRoot: string,
  requestedPath: string,
): {
  absolutePath: string;
  relativePath: string;
} {
  const trimmed = requestedPath.trim();
  if (!trimmed) {
    throw new Error('Artifact path is required.');
  }

  const absoluteCandidate = path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(workspaceRoot, trimmed);
  const realWorkspaceRoot = realpathSync(workspaceRoot);
  const realCandidate = realpathSync(absoluteCandidate);

  if (!isSubPath(realWorkspaceRoot, realCandidate)) {
    throw new Error('Artifacts can only be shared from inside the workspace root.');
  }

  return {
    absolutePath: realCandidate,
    relativePath: path.relative(realWorkspaceRoot, realCandidate).replaceAll(path.sep, '/'),
  };
}

function formatSpawnError(
  provider: WorkspaceProvider,
  error: Error,
): string {
  const code = 'code' in error ? error.code : undefined;
  if (code !== 'ENOENT') {
    return error.message;
  }

  if (provider === 'codex') {
    return [
      'Unable to launch Codex CLI.',
      'Set CODEX_BIN or install Codex in a standard location such as /Applications/Codex.app/Contents/Resources/codex.',
      `Original error: ${error.message}`,
    ].join(' ');
  }

  if (provider === 'gemini') {
    return [
      'Unable to launch Gemini CLI.',
      'Set GEMINI_BIN or ensure gemini is available on the host PATH.',
      `Original error: ${error.message}`,
    ].join(' ');
  }

  if (provider === 'claude') {
    return [
      'Unable to launch Claude Code CLI.',
      'Set CLAUDE_BIN or ensure claude is available on the host PATH.',
      `Original error: ${error.message}`,
    ].join(' ');
  }

  return error.message;
}

function providerDisplayName(provider: WorkspaceProvider): string {
  if (provider === 'codex') {
    return 'Codex';
  }

  if (provider === 'claude') {
    return 'Claude Code';
  }

  return 'Gemini';
}
