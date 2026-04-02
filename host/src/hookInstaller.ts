import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BRIDGE_FILE_NAME = 'gemini-remote-bridge.js';
const HOOK_NAME = 'gemini-remote-bridge';
const VERSION_MARKER = 'gemini-remote-hook-v1';
const REQUIRED_EVENTS = [
  'SessionStart',
  'AfterModel',
  'BeforeTool',
  'AfterTool',
  'AfterAgent',
  'SessionEnd',
  'Notification',
] as const;

type SettingsShape = {
  hooks?: Record<
    string,
    Array<{
      matcher?: string;
      hooks?: Array<{
        name?: string;
        type?: string;
        command?: string;
      }>;
    }>
  >;
};

export function installHooks(rootPath: string): void {
  const geminiDir = path.join(rootPath, '.gemini');
  const hooksDir = path.join(geminiDir, 'hooks');
  const settingsPath = path.join(geminiDir, 'settings.json');
  const bridgePath = path.join(hooksDir, BRIDGE_FILE_NAME);

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(bridgePath, createBridgeScript(), 'utf8');

  const current = readSettings(settingsPath);
  const hooks = current.hooks ?? {};

  for (const eventName of REQUIRED_EVENTS) {
    const eventDefinitions = hooks[eventName] ?? [];
    const cleaned = eventDefinitions.map((definition) => ({
      matcher: definition.matcher ?? '*',
      hooks: (definition.hooks ?? []).filter((hook) => hook.name !== HOOK_NAME),
    }));
    const wildcard = cleaned.find((definition) => definition.matcher === '*');

    if (wildcard) {
      wildcard.hooks = wildcard.hooks ?? [];
      wildcard.hooks.push({
        name: HOOK_NAME,
        type: 'command',
        command: `node .gemini/hooks/${BRIDGE_FILE_NAME}`,
      });
      hooks[eventName] = cleaned;
      continue;
    }

    hooks[eventName] = [
      ...cleaned,
      {
        matcher: '*',
        hooks: [
          {
            name: HOOK_NAME,
            type: 'command',
            command: `node .gemini/hooks/${BRIDGE_FILE_NAME}`,
          },
        ],
      },
    ];
  }

  writeFileSync(
    settingsPath,
    `${JSON.stringify({ ...current, hooks }, null, 2)}\n`,
    'utf8',
  );
}

export function getHookStatus(rootPath: string): 'installed' | 'missing' {
  const settingsPath = path.join(rootPath, '.gemini', 'settings.json');
  const bridgePath = path.join(rootPath, '.gemini', 'hooks', BRIDGE_FILE_NAME);

  if (!existsSync(settingsPath) || !existsSync(bridgePath)) {
    return 'missing';
  }

  const bridgeText = readFileSync(bridgePath, 'utf8');
  if (!bridgeText.includes(VERSION_MARKER)) {
    return 'missing';
  }

  const settings = readSettings(settingsPath);
  for (const eventName of REQUIRED_EVENTS) {
    const eventDefinitions = settings.hooks?.[eventName] ?? [];
    const found = eventDefinitions.some((definition) =>
      (definition.hooks ?? []).some((hook) => hook.name === HOOK_NAME),
    );
    if (!found) {
      return 'missing';
    }
  }

  return 'installed';
}

function readSettings(settingsPath: string): SettingsShape {
  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8')) as SettingsShape;
  } catch (error) {
    throw new Error(
      `Failed to parse ${settingsPath}: ${
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
    process.stdout.write('{}');
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
    // Telemetry failures should never block Gemini.
  }

  process.stdout.write('{}');
}

main().catch(() => {
  process.stdout.write('{}');
});
`;
}
