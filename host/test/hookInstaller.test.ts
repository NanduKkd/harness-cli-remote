import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { getClaudeHookStatus, installClaudeHooks } from '../src/claudeHookInstaller.js';
import { getCodexHookStatus, installCodexHooks } from '../src/codexHookInstaller.js';
import { installHooks } from '../src/hookInstaller.js';
import { cleanupTempDir, makeTempDir } from './testUtils.js';

test('installClaudeHooks preserves unrelated hooks and de-duplicates the bridge entry', async (t) => {
  const tempDir = await makeTempDir('gemini-remote-claude-hooks-');
  t.after(async () => {
    await cleanupTempDir(tempDir);
  });

  const claudeDir = path.join(tempDir, '.claude');
  await mkdir(path.join(claudeDir, 'hooks'), { recursive: true });
  await writeFile(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: '.*',
              hooks: [
                {
                  type: 'command',
                  command:
                    'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/claude-remote-bridge.js"',
                },
                {
                  type: 'command',
                  command: './existing-pre-tool.sh',
                },
              ],
            },
          ],
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: './existing-session-start.sh',
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  );

  installClaudeHooks(tempDir);

  const settings = JSON.parse(
    await readFile(path.join(claudeDir, 'settings.json'), 'utf8'),
  ) as {
    hooks?: Record<
      string,
      Array<{
        matcher?: string;
        hooks?: Array<{ command?: string }>;
      }>
    >;
  };
  const preToolHooks =
    settings.hooks?.PreToolUse?.flatMap((entry) => entry.hooks ?? []) ?? [];
  const bridgeHooks = preToolHooks.filter(
    (hook) =>
      hook.command ===
      'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/claude-remote-bridge.js"',
  );

  assert.equal(bridgeHooks.length, 1);
  assert.ok(
    preToolHooks.some((hook) => hook.command === './existing-pre-tool.sh'),
  );
  assert.ok(
    settings.hooks?.SessionStart?.some((entry) =>
      (entry.hooks ?? []).some(
        (hook) => hook.command === './existing-session-start.sh',
      ),
    ),
  );
  assert.equal(getClaudeHookStatus(tempDir), 'installed');
});

test('installCodexHooks preserves unrelated hooks and de-duplicates the bridge entry', async (t) => {
  const tempDir = await makeTempDir('gemini-remote-hooks-');
  t.after(async () => {
    await cleanupTempDir(tempDir);
  });

  const codexDir = path.join(tempDir, '.codex');
  await mkdir(path.join(codexDir, 'hooks'), { recursive: true });
  await writeFile(
    path.join(codexDir, 'hooks.json'),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume',
              hooks: [
                {
                  type: 'command',
                  command:
                    'node "$(git rev-parse --show-toplevel)/.codex/hooks/codex-remote-bridge.js"',
                  statusMessage: 'Old bridge',
                },
                {
                  type: 'command',
                  command: 'python3 ./existing-hook.py',
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  );

  installCodexHooks(tempDir);

  const hooks = JSON.parse(
    await readFile(path.join(codexDir, 'hooks.json'), 'utf8'),
  ) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  };
  const sessionStartHooks =
    hooks.hooks?.SessionStart?.flatMap((entry) => entry.hooks ?? []) ?? [];
  const bridgeHooks = sessionStartHooks.filter(
    (hook) =>
      hook.command ===
      'node "$(git rev-parse --show-toplevel)/.codex/hooks/codex-remote-bridge.js"',
  );

  assert.equal(bridgeHooks.length, 1);
  assert.ok(
    sessionStartHooks.some((hook) => hook.command === 'python3 ./existing-hook.py'),
  );
  assert.equal(getCodexHookStatus(tempDir), 'installed');
});

test('installHooks adds the Gemini artifact MCP server without removing existing settings', async (t) => {
  const tempDir = await makeTempDir('gemini-remote-gemini-hooks-');
  t.after(async () => {
    await cleanupTempDir(tempDir);
  });

  const geminiDir = path.join(tempDir, '.gemini');
  await mkdir(geminiDir, { recursive: true });
  await writeFile(
    path.join(geminiDir, 'settings.json'),
    JSON.stringify(
      {
        mcpServers: {
          existing: {
            command: 'node',
            args: ['existing.js'],
          },
        },
      },
      null,
      2,
    ),
  );

  installHooks({
    id: 'workspace-1',
    name: 'Workspace',
    rootPath: tempDir,
    provider: 'gemini',
  });

  const settings = JSON.parse(
    await readFile(path.join(geminiDir, 'settings.json'), 'utf8'),
  ) as {
    hooks?: Record<string, unknown>;
    mcpServers?: Record<
      string,
      {
        command?: string;
        args?: string[];
        env?: Record<string, string>;
      }
    >;
  };

  assert.ok(settings.hooks?.SessionStart);
  assert.deepEqual(settings.mcpServers?.existing?.args, ['existing.js']);
  assert.equal(settings.mcpServers?.gemini_remote_artifacts?.command, 'node');
  assert.ok(
    settings.mcpServers?.gemini_remote_artifacts?.args?.[0]?.endsWith(
      'host/scripts/file-share-mcp-server.js',
    ),
  );
  assert.equal(
    settings.mcpServers?.gemini_remote_artifacts?.env?.REMOTE_SESSION_ID,
    '${REMOTE_SESSION_ID}',
  );
});
