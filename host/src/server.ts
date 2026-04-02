import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import { z } from 'zod';

import { AppDatabase } from './db.js';
import { GeminiService } from './geminiService.js';
import { getHookStatus, installHooks } from './hookInstaller.js';
import type { BroadcastEnvelope, HookIngressBody, ResolvedConfig } from './types.js';
import { createPairingCode } from './util.js';

const pairSchema = z.object({
  code: z.string().min(1),
});

const createSessionSchema = z.object({
  workspaceId: z.string().min(1),
  prompt: z.string().min(1),
});

const promptSchema = z.object({
  prompt: z.string().min(1),
});

export async function startServer(config: ResolvedConfig): Promise<void> {
  const app = Fastify({
    logger: true,
  });
  const database = new AppDatabase(config.server.databasePath);
  const workspaces = new Map(config.workspaces.map((workspace) => [workspace.id, workspace]));
  const sockets = new Set<WebSocket>();
  const pairingCode = createPairingCode();
  const daemonUrl = `http://127.0.0.1:${config.server.port}`;

  for (const workspace of config.workspaces) {
    try {
      installHooks(workspace.rootPath);
    } catch (error) {
      app.log.warn(
        {
          err: error,
          workspaceId: workspace.id,
          rootPath: workspace.rootPath,
        },
        'Failed to auto-install Gemini Remote hooks for workspace',
      );
    }
  }

  database.syncWorkspaces(config.workspaces);

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

  const gemini = new GeminiService(
    database,
    workspaces,
    daemonUrl,
    app.log,
    broadcast,
  );

  app.addHook('onClose', async () => {
    database.close();
  });

  app.get('/health', async () => ({
    ok: true,
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
      request.url.startsWith('/ws')
    ) {
      return;
    }

    if (!isAuthorized(database, request)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/workspaces', async () => {
    return database.listWorkspaces((rootPath) => getHookStatus(rootPath));
  });

  app.get('/sessions', async (request) => {
    const workspaceId = String((request.query as Record<string, string>).workspaceId ?? '');
    return database.listSessions(workspaceId);
  });

  app.post('/sessions', async (request, reply) => {
    const body = createSessionSchema.parse(request.body);
    const session = gemini.createSession(body.workspaceId, body.prompt);
    return reply.code(201).send(session);
  });

  app.post('/sessions/:id/prompts', async (request) => {
    const body = promptSchema.parse(request.body);
    return gemini.sendPrompt((request.params as { id: string }).id, body.prompt);
  });

  app.post('/sessions/:id/cancel', async (request, reply) => {
    const ok = gemini.cancelSession((request.params as { id: string }).id);
    if (!ok) {
      return reply.code(409).send({ error: 'Session has no active run' });
    }

    return { ok: true };
  });

  app.get('/sessions/:id/events', async (request) => {
    const afterSeq = Number((request.query as Record<string, string>).afterSeq ?? '0');
    return database.getEvents((request.params as { id: string }).id, afterSeq);
  });

  app.post('/internal/hooks', async (request, reply) => {
    const token = request.headers['x-hook-token'];
    if (typeof token !== 'string' || token.length === 0) {
      return reply.code(401).send({ error: 'Missing hook token' });
    }

    const body = request.body as HookIngressBody;
    try {
      const events = gemini.handleHookIngress(token, body);
      return reply.send({ ok: true, events: events.length });
    } catch (error) {
      app.log.warn({ err: error }, 'Hook ingress rejected');
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
      workspaces: config.workspaces.map((workspace) => workspace.rootPath),
    },
    'Gemini Remote host started',
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
