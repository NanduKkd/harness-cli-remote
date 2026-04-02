#!/usr/bin/env node
// gemini-remote-hook-v1
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
