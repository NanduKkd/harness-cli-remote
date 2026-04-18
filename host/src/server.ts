import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import { z } from 'zod';

import { AppDatabase } from './db.js';
import { SessionService, SessionServiceError } from './sessionService.js';
import { getHookStatus, installHooks } from './hookInstaller.js';
import type {
  BroadcastEnvelope,
  HookIngressBody,
  ResolvedConfig,
  ArtifactRegistrationBody,
  SessionExportRecord,
  WorkspaceConfig,
  WorkspaceRecord,
  WorkspaceRepairRecord,
} from './types.js';
import { createPairingCode } from './util.js';

const pairSchema = z.object({
  code: z.string().min(1),
});

const createSessionSchema = z.object({
  workspaceId: z.string().min(1),
  model: z.string().trim().min(1).optional(),
  prompt: z.string().min(1),
});

const promptSchema = z.object({
  model: z.string().trim().min(1).optional(),
  prompt: z.string().min(1),
});

const createWorkspaceSchema = z.object({
  name: z.string().trim().optional(),
  rootPath: z.string().trim().min(1),
  provider: z.enum(['gemini', 'codex']).default('gemini'),
});

const browseDirectoriesSchema = z.object({
  path: z.string().trim().optional(),
});

const registerArtifactSchema = z.object({
  remoteSessionId: z.string().min(1),
  remoteRunId: z.string().min(1),
  path: z.string().trim().min(1),
  title: z.string().trim().optional(),
  mimeType: z.string().trim().optional(),
  requestedAt: z.string().min(1),
});

export async function startServer(config: ResolvedConfig): Promise<void> {
  const app = Fastify({
    logger: true,
  });
  const database = new AppDatabase(config.server.databasePath);
  const recoveredRuns = database.recoverOrphanedRuns(
    'The host restarted before this run finished. Start a new session or resend the prompt.',
  );
  database.syncWorkspaces(config.workspaces);
  const workspaces = new Map<string, WorkspaceConfig>();
  refreshWorkspaceMap(database, workspaces);
  const sockets = new Set<WebSocket>();
  const pairingCode = createPairingCode();
  const daemonUrl = `http://127.0.0.1:${config.server.port}`;

  if (recoveredRuns.length > 0) {
    app.log.warn(
      {
        recoveredRuns,
        count: recoveredRuns.length,
      },
      'Recovered orphaned running sessions from a previous daemon instance',
    );
  }

  for (const workspace of workspaces.values()) {
    try {
      installHooks(workspace);
    } catch (error) {
      app.log.warn(
        {
          err: error,
          workspaceId: workspace.id,
          rootPath: workspace.rootPath,
        },
        'Failed to auto-install workspace hooks',
      );
    }
  }

  await app.register(cors, {
    origin: true,
  });
  await app.register(websocket);

  const broadcast = (envelope: BroadcastEnvelope) => {
    const payload = JSON.stringify(envelope);
    for (const socket of sockets) {
      if (socket.readyState === 1) {
        socket.send(payload);
      }
    }
  };

  const sessions = new SessionService(
    database,
    workspaces,
    daemonUrl,
    app.log,
    broadcast,
    config.server.artifactsPath,
  );

  app.addHook('onClose', async () => {
    database.close();
  });

  app.get('/health', async () => ({
    ok: true,
    workspaceCount: workspaces.size,
  }));

  app.post('/pair', async (request, reply) => {
    const body = pairSchema.parse(request.body);
    if (body.code !== pairingCode) {
      return reply.code(401).send({ error: 'Invalid pairing code' });
    }

    return reply.send({ token: database.issueToken() });
  });

  app.get(
    '/ws',
    { websocket: true },
    async (socket, request) => {
      const token = String((request.query as Record<string, string>).token ?? '');
      if (!database.validateToken(token)) {
        socket.close(4001, 'Unauthorized');
        return;
      }

      sockets.add(socket);
      socket.send(
        JSON.stringify({
          type: 'hello',
          ts: new Date().toISOString(),
        }),
      );
      socket.on('close', () => {
        sockets.delete(socket);
      });
    },
  );

  app.addHook('preHandler', async (request, reply) => {
    if (
      request.url.startsWith('/health') ||
      request.url.startsWith('/pair') ||
      request.url.startsWith('/internal/hooks') ||
      request.url.startsWith('/internal/artifacts') ||
      request.url.startsWith('/ws')
    ) {
      return;
    }

    if (!isAuthorized(database, request)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/workspaces', async () => {
    return database.listWorkspaces((workspace) => getHookStatus(workspace));
  });

  app.post('/workspaces', async (request, reply) => {
    const body = createWorkspaceSchema.parse(request.body);
    const rootPath = path.resolve(body.rootPath);

    if (!existsSync(rootPath)) {
      return reply.code(400).send({ error: `Path does not exist: ${rootPath}` });
    }

    if (!statSync(rootPath).isDirectory()) {
      return reply.code(400).send({ error: `Path is not a directory: ${rootPath}` });
    }

    const duplicate = [...workspaces.values()].find(
      (workspace) =>
        workspace.rootPath === rootPath && workspace.provider === body.provider,
    );
    if (duplicate) {
      return reply.code(409).send({
        error: `Workspace already exists for ${body.provider} at ${rootPath}`,
      });
    }

    const workspace: WorkspaceConfig = {
      id: createWorkspaceId(
        body.name?.trim() || path.basename(rootPath) || 'workspace',
        body.provider,
        workspaces,
      ),
      name: body.name?.trim() || path.basename(rootPath) || rootPath,
      rootPath,
      provider: body.provider,
    };

    database.upsertWorkspace(workspace);
    workspaces.set(workspace.id, workspace);

    let warning: string | null = null;
    try {
      installHooks(workspace);
      database.markWorkspaceRepaired(workspace.id, new Date().toISOString());
    } catch (error) {
      warning = error instanceof Error ? error.message : String(error);
      app.log.warn(
        {
          err: error,
          workspaceId: workspace.id,
          rootPath: workspace.rootPath,
        },
        'Failed to auto-install hooks for created workspace',
      );
    }

    const stored = database.getWorkspaceOrThrow(workspace.id);
    const record = toWorkspaceRecord(workspace, stored.repairedAt);
    return reply.code(201).send(
      warning == null ? record : { workspace: record, warning },
    );
  });

  app.get('/workspaces/browse', async (request, reply) => {
    const query = browseDirectoriesSchema.parse(request.query);

    let currentPath: string;
    try {
      currentPath = resolveDirectoryPath(query.path);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const directories = readdirSync(currentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(currentPath, entry.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 200);

    const parentPath = path.dirname(currentPath);
    return reply.send({
      currentPath,
      parentPath: parentPath === currentPath ? null : parentPath,
      directories,
    });
  });

  app.post('/workspaces/:id/repair', async (request, reply) => {
    const workspace = workspaces.get((request.params as { id: string }).id);
    if (!workspace) {
      return reply.code(404).send({ error: 'Workspace not found' });
    }

    try {
      installHooks(workspace);
    } catch (error) {
      app.log.warn(
        {
          err: error,
          workspaceId: workspace.id,
          rootPath: workspace.rootPath,
        },
        'Workspace repair failed',
      );
      return reply.code(500).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const repairedAt = new Date().toISOString();
    database.markWorkspaceRepaired(workspace.id, repairedAt);
    const repairedWorkspace: WorkspaceRepairRecord = {
      ...toWorkspaceRecord(workspace, repairedAt),
      repairedAt,
    };
    return reply.send(repairedWorkspace);
  });

  app.get('/sessions', async (request) => {
    const workspaceId = String((request.query as Record<string, string>).workspaceId ?? '');
    sessions.reconcileDetachedRuns(workspaceId);
    return database.listSessions(workspaceId);
  });

  app.post('/sessions', async (request, reply) => {
    const body = createSessionSchema.parse(request.body);
    try {
      const session = sessions.createSession(
        body.workspaceId,
        body.prompt,
        body.model,
      );
      return reply.code(201).send(session);
    } catch (error) {
      return sendSessionServiceError(reply, error);
    }
  });

  app.post('/sessions/:id/prompts', async (request, reply) => {
    const body = promptSchema.parse(request.body);
    try {
      return sessions.sendPrompt(
        (request.params as { id: string }).id,
        body.prompt,
        body.model,
      );
    } catch (error) {
      return sendSessionServiceError(reply, error);
    }
  });

  app.post('/sessions/:id/cancel', async (request, reply) => {
    const ok = sessions.cancelSession((request.params as { id: string }).id);
    if (!ok) {
      return reply.code(409).send({ error: 'Session has no active run' });
    }

    return { ok: true };
  });

  app.delete('/sessions/:id', async (request, reply) => {
    const outcome = sessions.deleteSession((request.params as { id: string }).id);
    if (outcome === 'deleted') {
      return { ok: true };
    }

    if (outcome === 'not_found') {
      return reply.code(404).send({ error: 'Session not found' });
    }

    if (outcome === 'active') {
      return reply.code(409).send({ error: 'Session has an active run' });
    }

    return reply.code(409).send({
      error: 'Only completed or cancelled sessions can be deleted',
    });
  });

  app.get('/sessions/:id/events', async (request) => {
    const sessionId = (request.params as { id: string }).id;
    sessions.reconcileDetachedSession(sessionId);
    const afterSeq = Number((request.query as Record<string, string>).afterSeq ?? '0');
    return database.getEvents(sessionId, afterSeq);
  });

  app.get('/sessions/:id/runs', async (request, reply) => {
    const sessionId = (request.params as { id: string }).id;
    sessions.reconcileDetachedSession(sessionId);
    const session = database.getSession(sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }

    return database.listRuns(session.id);
  });

  app.get('/sessions/:id/artifacts', async (request, reply) => {
    const sessionId = (request.params as { id: string }).id;
    sessions.reconcileDetachedSession(sessionId);
    const session = database.getSession(sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }

    return sessions.listArtifacts(session.id);
  });

  app.get('/sessions/:id/export', async (request, reply) => {
    const sessionId = (request.params as { id: string }).id;
    sessions.reconcileDetachedSession(sessionId);
    const session = database.getSession(sessionId);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }

    const workspace = workspaces.get(session.workspaceId);
    if (!workspace) {
      return reply.code(404).send({ error: 'Workspace not found' });
    }

    const payload: SessionExportRecord = {
      exportedAt: new Date().toISOString(),
      workspace: toWorkspaceRecord(
        workspace,
        database.getWorkspace(workspace.id)?.repairedAt,
      ),
      session,
      runs: database.listRuns(session.id),
      events: database.getEvents(session.id, 0),
      artifacts: sessions.listArtifacts(session.id),
    };

    reply.header(
      'content-disposition',
      `attachment; filename="session-${session.id}.json"`,
    );
    return reply.send(payload);
  });

  app.get('/artifacts/:id/download', async (request, reply) => {
    const artifactId = (request.params as { id: string }).id;
    const artifact = sessions.getArtifactRecord(artifactId);
    if (!artifact) {
      return reply.code(404).send({ error: 'Artifact not found' });
    }

    if (!existsSync(artifact.storedPath)) {
      return reply.code(410).send({ error: 'Artifact file is no longer available' });
    }

    const stats = statSync(artifact.storedPath);
    reply.header('content-type', artifact.mediaType);
    reply.header('content-length', `${stats.size}`);
    reply.header(
      'content-disposition',
      `attachment; filename="${artifact.filename.replaceAll('"', '_')}"`,
    );
    return reply.send(createReadStream(artifact.storedPath));
  });

  app.post('/internal/hooks', async (request, reply) => {
    const token = request.headers['x-hook-token'];
    if (typeof token !== 'string' || token.length === 0) {
      return reply.code(401).send({ error: 'Missing hook token' });
    }

    const body = request.body as HookIngressBody;
    try {
      const events = sessions.handleHookIngress(token, body);
      return reply.send({ ok: true, events: events.length });
    } catch (error) {
      app.log.warn({ err: error }, 'Hook ingress rejected');
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/internal/artifacts', async (request, reply) => {
    const token = request.headers['x-hook-token'];
    if (typeof token !== 'string' || token.length === 0) {
      return reply.code(401).send({ error: 'Missing hook token' });
    }

    try {
      const body = registerArtifactSchema.parse(
        request.body,
      ) as ArtifactRegistrationBody;
      const artifact = sessions.registerArtifact(token, body);
      return reply.code(201).send(artifact);
    } catch (error) {
      app.log.warn({ err: error }, 'Artifact ingress rejected');
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await app.listen({
    host: config.server.host,
    port: config.server.port,
  });

  app.log.info(
    {
      configPath: config.configPath,
      workspaces: [...workspaces.values()].map((workspace) => ({
        id: workspace.id,
        provider: workspace.provider,
        rootPath: workspace.rootPath,
      })),
    },
    'Remote host started',
  );
  app.log.info(
    `Pairing code: ${pairingCode}. Use the Flutter app Pair screen to connect.`,
  );
}

function isAuthorized(
  database: AppDatabase,
  request: FastifyRequest,
): boolean {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return false;
  }

  return database.validateToken(auth.slice('Bearer '.length));
}

function sendSessionServiceError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof SessionServiceError)) {
    throw error;
  }

  const message = error.message;
  if (message.startsWith('Unknown session:')) {
    return reply.code(error.statusCode).send({ error: 'Session not found' });
  }

  if (message.startsWith('Unknown workspace:')) {
    return reply.code(error.statusCode).send({ error: 'Workspace not found' });
  }

  return reply.code(error.statusCode).send({ error: message });
}

function toWorkspaceRecord(
  workspace: WorkspaceConfig,
  repairedAt?: string | null,
): WorkspaceRecord {
  return {
    ...workspace,
    repairedAt,
    hookStatus: getHookStatus(workspace),
  };
}

function refreshWorkspaceMap(
  database: AppDatabase,
  workspaces: Map<string, WorkspaceConfig>,
): void {
  workspaces.clear();
  for (const workspace of database.listWorkspaceConfigs()) {
    workspaces.set(workspace.id, workspace);
  }
}

function createWorkspaceId(
  name: string,
  provider: WorkspaceConfig['provider'],
  workspaces: Map<string, WorkspaceConfig>,
): string {
  const base = `${slugify(name)}-${provider}`;
  let candidate = base;
  let index = 2;

  while (workspaces.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }

  return candidate;
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'workspace';
}

function resolveDirectoryPath(inputPath?: string): string {
  const initial = inputPath && inputPath.length > 0 ? inputPath : os.homedir();
  let candidate = path.resolve(initial);

  while (!existsSync(candidate) && candidate !== path.dirname(candidate)) {
    candidate = path.dirname(candidate);
  }

  if (!existsSync(candidate)) {
    throw new Error(`Path does not exist: ${initial}`);
  }

  if (!statSync(candidate).isDirectory()) {
    candidate = path.dirname(candidate);
  }

  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error(`Path is not a directory: ${initial}`);
  }

  return candidate;
}
