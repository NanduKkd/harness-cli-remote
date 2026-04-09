import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { getCodexHookStatus, installCodexHooks } from '../src/codexHookInstaller.js';
import { cleanupTempDir, makeTempDir } from './testUtils.js';

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
