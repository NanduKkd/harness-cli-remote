import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function cleanupTempDir(dirPath: string): Promise<void> {
  await rm(dirPath, { recursive: true, force: true });
}

export async function waitFor<T>(
  action: () => T,
  predicate: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const startedAt = Date.now();

  while (true) {
    const value = action();
    if (predicate(value)) {
      return value;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      assert.fail('Timed out while waiting for condition.');
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function createLogger(): FastifyBaseLogger {
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    fatal() {},
    trace() {},
    child() {
      return logger;
    },
  };

  return logger as unknown as FastifyBaseLogger;
}
