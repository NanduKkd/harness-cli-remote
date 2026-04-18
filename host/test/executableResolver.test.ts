import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { resolveExecutable } from '../src/executableResolver.js';
import { cleanupTempDir, makeTempDir } from './testUtils.js';

test('resolveExecutable prefers an explicit env override', async (t) => {
  const tempDir = await makeTempDir('gemini-remote-executable-override-');
  t.after(async () => {
    await cleanupTempDir(tempDir);
  });

  const executablePath = path.join(tempDir, 'codex');
  await writeExecutable(executablePath);

  const resolved = resolveExecutable('codex', {
    env: {
      CODEX_BIN: executablePath,
      PATH: '',
    },
    envVar: 'CODEX_BIN',
  });

  assert.equal(resolved, executablePath);
});

test('resolveExecutable finds commands on PATH', async (t) => {
  const tempDir = await makeTempDir('gemini-remote-executable-path-');
  t.after(async () => {
    await cleanupTempDir(tempDir);
  });

  const binDir = path.join(tempDir, 'bin');
  const executablePath = path.join(binDir, 'codex');
  await mkdir(binDir, { recursive: true });
  await writeExecutable(executablePath);

  const resolved = resolveExecutable('codex', {
    env: {
      PATH: binDir,
    },
  });

  assert.equal(resolved, executablePath);
});

test('resolveExecutable falls back to a known absolute path when PATH is missing it', async (t) => {
  const tempDir = await makeTempDir('gemini-remote-executable-fallback-');
  t.after(async () => {
    await cleanupTempDir(tempDir);
  });

  const fallbackPath = path.join(tempDir, 'Codex.app', 'Contents', 'Resources', 'codex');
  await mkdir(path.dirname(fallbackPath), { recursive: true });
  await writeExecutable(fallbackPath);

  const resolved = resolveExecutable('codex', {
    env: {
      PATH: '',
    },
    fallbackPaths: [fallbackPath],
  });

  assert.equal(resolved, fallbackPath);
});

async function writeExecutable(filePath: string): Promise<void> {
  await writeFile(filePath, '#!/bin/sh\nexit 0\n');
  await chmod(filePath, 0o755);
}
