import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BRIDGE_FILE_NAME = 'claude-remote-bridge.js';
const VERSION_MARKER = 'gemini-remote-claude-hook-v1';
const TOOL_MATCHER = '.*';
const BRIDGE_COMMAND =
  'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/claude-remote-bridge.js"';
type RequiredHook = {
  eventName: string;
  matcher?: string;
};

const REQUIRED_HOOKS: readonly RequiredHook[] = [
  { eventName: 'SessionStart' },
  { eventName: 'PreToolUse', matcher: TOOL_MATCHER },
  { eventName: 'PostToolUse', matcher: TOOL_MATCHER },
  { eventName: 'PostToolUseFailure', matcher: TOOL_MATCHER },
  { eventName: 'Notification' },
  { eventName: 'Stop' },
  { eventName: 'StopFailure' },
] as const;

type SettingsShape = {
  hooks?: Record<
    string,
    Array<{
      matcher?: string;
      hooks?: Array<{
        type?: string;
        command?: string;
        timeout?: number;
      }>;
    }>
  >;
};

type HookDefinition = NonNullable<SettingsShape['hooks']>[string][number];

export function installClaudeHooks(rootPath: string): void {
  const claudeDir = path.join(rootPath, '.claude');
  const hooksDir = path.join(claudeDir, 'hooks');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const bridgePath = path.join(hooksDir, BRIDGE_FILE_NAME);

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(bridgePath, createBridgeScript(), 'utf8');

  const current = readSettings(settingsPath);
  const hooks = current.hooks ?? {};

  for (const required of REQUIRED_HOOKS) {
    const eventDefinitions = hooks[required.eventName] ?? [];
    const cleaned: HookDefinition[] = eventDefinitions.map((definition) => ({
      matcher: definition.matcher,
      hooks: (definition.hooks ?? []).filter(
        (hook) => hook.command !== BRIDGE_COMMAND,
      ),
    }));
    const target = cleaned.find(
      (definition) => definition.matcher === required.matcher,
    );

    if (target) {
      target.hooks = target.hooks ?? [];
      target.hooks.push({
        type: 'command',
        command: BRIDGE_COMMAND,
      });
    } else {
      const nextDefinition: {
        matcher?: string;
        hooks: Array<{
          type?: string;
          command?: string;
          timeout?: number;
        }>;
      } = {
        hooks: [
          {
            type: 'command',
            command: BRIDGE_COMMAND,
          },
        ],
      };
      if (required.matcher !== undefined) {
        nextDefinition.matcher = required.matcher;
      }
      cleaned.push(nextDefinition);
    }

    hooks[required.eventName] = cleaned;
  }

  writeFileSync(
    settingsPath,
    `${JSON.stringify({ ...current, hooks }, null, 2)}\n`,
    'utf8',
  );
}

export function getClaudeHookStatus(rootPath: string): 'installed' | 'missing' {
  const settingsPath = path.join(rootPath, '.claude', 'settings.json');
  const bridgePath = path.join(rootPath, '.claude', 'hooks', BRIDGE_FILE_NAME);

  if (!existsSync(settingsPath) || !existsSync(bridgePath)) {
    return 'missing';
  }

  const bridgeText = readFileSync(bridgePath, 'utf8');
  if (!bridgeText.includes(VERSION_MARKER)) {
    return 'missing';
  }

  const settings = readSettings(settingsPath);
  for (const required of REQUIRED_HOOKS) {
    const eventDefinitions = settings.hooks?.[required.eventName] ?? [];
    const found = eventDefinitions.some(
      (definition) =>
        definition.matcher === required.matcher &&
        (definition.hooks ?? []).some((hook) => hook.command === BRIDGE_COMMAND),
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
    // Telemetry failures should never block Claude Code.
  }
}

main().catch(() => {});
`;
}
