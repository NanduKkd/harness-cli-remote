import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import { cleanupTempDir, makeTempDir } from './testUtils.js';

test('loadConfig defaults missing workspace providers to gemini', async (t) => {
  const tempDir = await makeTempDir('gemini-remote-config-');
  t.after(async () => {
    await cleanupTempDir(tempDir);
  });

  const configDir = path.join(tempDir, 'config');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, 'local.json'),
    JSON.stringify(
      {
        server: {
          host: '127.0.0.1',
          port: 9000,
          databasePath: './data/test.sqlite',
        },
        workspaces: [
          {
            id: 'legacy',
            name: 'Legacy Workspace',
            rootPath: '../legacy-workspace',
          },
          {
            id: 'codex',
            name: 'Codex Workspace',
            rootPath: '../codex-workspace',
            provider: 'codex',
          },
        ],
      },
      null,
      2,
    ),
  );

  const config = loadConfig(path.join(configDir, 'local.json'));

  assert.equal(config.workspaces[0]?.provider, 'gemini');
  assert.equal(config.workspaces[1]?.provider, 'codex');
  assert.equal(
    config.workspaces[0]?.rootPath,
    path.resolve(configDir, '../legacy-workspace'),
  );
  assert.equal(
    config.server.databasePath,
    path.resolve(configDir, './data/test.sqlite'),
  );
});
