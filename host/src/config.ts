import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { ResolvedConfig } from './types.js';

const configSchema = z.object({
  server: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.number().int().positive().default(8918),
    databasePath: z.string().default('./data/gemini-remote.sqlite'),
  }),
  workspaces: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        rootPath: z.string().min(1),
      }),
    )
    .min(1),
});

export function loadConfig(configPathArg?: string): ResolvedConfig {
  const configPath = path.resolve(
    process.cwd(),
    configPathArg ?? './config/local.json',
  );

  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const parsed = configSchema.parse(
    JSON.parse(readFileSync(configPath, 'utf8')),
  );
  const configDir = path.dirname(configPath);
  const seenIds = new Set<string>();

  const workspaces = parsed.workspaces.map((workspace) => {
    if (seenIds.has(workspace.id)) {
      throw new Error(`Duplicate workspace id: ${workspace.id}`);
    }
    seenIds.add(workspace.id);

    return {
      ...workspace,
      rootPath: path.resolve(configDir, workspace.rootPath),
    };
  });

  return {
    configPath,
    server: {
      host: parsed.server.host,
      port: parsed.server.port,
      databasePath: path.resolve(configDir, parsed.server.databasePath),
    },
    workspaces,
  };
}
