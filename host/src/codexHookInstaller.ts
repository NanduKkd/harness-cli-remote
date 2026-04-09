import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BRIDGE_FILE_NAME = 'codex-remote-bridge.js';
const VERSION_MARKER = 'gemini-remote-codex-hook-v1';
const REQUIRED_EVENT = 'SessionStart';
const BRIDGE_COMMAND =
  'node "$(git rev-parse --show-toplevel)/.codex/hooks/codex-remote-bridge.js"';

type HooksShape = {
  hooks?: Record<
    string,
    Array<{
      matcher?: string;
      hooks?: Array<{
        type?: string;
        command?: string;
        statusMessage?: string;
        timeout?: number;
        timeoutSec?: number;
      }>;
    }>
  >;
};

export function installCodexHooks(rootPath: string): void {
  const codexDir = path.join(rootPath, '.codex');
  const hooksDir = path.join(codexDir, 'hooks');
  const hooksPath = path.join(codexDir, 'hooks.json');
  const bridgePath = path.join(hooksDir, BRIDGE_FILE_NAME);

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(bridgePath, createBridgeScript(), 'utf8');

  const current = readHooks(hooksPath);
  const hooks = current.hooks ?? {};
  const eventDefinitions = hooks[REQUIRED_EVENT] ?? [];
  const cleaned = eventDefinitions.map((definition) => ({
    matcher: definition.matcher ?? '*',
    hooks: (definition.hooks ?? []).filter((hook) => hook.command !== BRIDGE_COMMAND),
  }));
  const matcher = cleaned.find((definition) => definition.matcher === 'startup|resume');

  if (matcher) {
    matcher.hooks = matcher.hooks ?? [];
    matcher.hooks.push({
      type: 'command',
      command: BRIDGE_COMMAND,
      statusMessage: 'Forwarding Codex session telemetry',
    });
  } else {
    cleaned.push({
      matcher: 'startup|resume',
      hooks: [
        {
          type: 'command',
          command: BRIDGE_COMMAND,
          statusMessage: 'Forwarding Codex session telemetry',
        },
      ],
    });
  }

  hooks[REQUIRED_EVENT] = cleaned;
  writeFileSync(
    hooksPath,
    `${JSON.stringify({ ...current, hooks }, null, 2)}\n`,
    'utf8',
  );
}

export function getCodexHookStatus(rootPath: string): 'installed' | 'missing' {
  const hooksPath = path.join(rootPath, '.codex', 'hooks.json');
  const bridgePath = path.join(rootPath, '.codex', 'hooks', BRIDGE_FILE_NAME);

  if (!existsSync(hooksPath) || !existsSync(bridgePath)) {
    return 'missing';
  }

  const bridgeText = readFileSync(bridgePath, 'utf8');
  if (!bridgeText.includes(VERSION_MARKER)) {
    return 'missing';
  }

  const hooks = readHooks(hooksPath);
  const eventDefinitions = hooks.hooks?.[REQUIRED_EVENT] ?? [];
  const found = eventDefinitions.some((definition) =>
    (definition.hooks ?? []).some((hook) => hook.command === BRIDGE_COMMAND),
  );

  return found ? 'installed' : 'missing';
}

function readHooks(hooksPath: string): HooksShape {
  if (!existsSync(hooksPath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(hooksPath, 'utf8')) as HooksShape;
  } catch (error) {
    throw new Error(
      `Failed to parse ${hooksPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function createBridgeScript(): string {
  return `#!/usr/bin/env node
// ${VERSION_MARKER}
const fs = require('node:fs');

async function main() {
  const daemonUrl = process.env.REMOTE_DAEMON_URL;
  const remoteSessionId = process.env.REMOTE_SESSION_ID;
  const remoteRunId = process.env.REMOTE_RUN_ID;
  const hookToken = process.env.REMOTE_HOOK_TOKEN;

  if (!daemonUrl || !remoteSessionId || !remoteRunId || !hookToken) {
    process.stdout.write('');
    return;
  }

  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_error) {
    raw = '';
  }

  let hookPayload;
  try {
    hookPayload = raw ? JSON.parse(raw) : {};
  } catch (_error) {
    hookPayload = { raw };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    try {
      await fetch(new URL('/internal/hooks', daemonUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hook-token': hookToken,
        },
        body: JSON.stringify({
          remoteSessionId,
          remoteRunId,
          hookPayload,
          receivedAt: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (_error) {
    // Telemetry failures should never block Codex.
  }
}

main().catch(() => {});
`;
}
