import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';

const serverScriptPath = path.join(
  process.cwd(),
  'scripts',
  'file-share-mcp-server.js',
);

test('file-share MCP server responds over JSONL transport', async () => {
  const output = await runServer(
    [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: {
            name: 'test-client',
            version: '1.0.0',
          },
        },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    ].join('\n') + '\n',
  );

  const messages = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.jsonrpc, '2.0');
  assert.equal(
    (messages[0]?.result as Record<string, unknown>)?.protocolVersion,
    '2025-06-18',
  );

  const tools = ((messages[1]?.result as Record<string, unknown>)?.tools ??
    []) as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'share_file');
});

test('file-share MCP server responds over Content-Length transport', async () => {
  const initializeMessage = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {
        name: 'test-client',
        version: '1.0.0',
      },
    },
  });
  const toolsListMessage = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });

  const output = await runServer(
    `Content-Length: ${Buffer.byteLength(initializeMessage, 'utf8')}\r\n\r\n${initializeMessage}` +
      `Content-Length: ${Buffer.byteLength(toolsListMessage, 'utf8')}\r\n\r\n${toolsListMessage}`,
  );

  const messages = parseContentLengthMessages(output);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.jsonrpc, '2.0');
  assert.equal(
    (messages[0]?.result as Record<string, unknown>)?.protocolVersion,
    '2025-06-18',
  );

  const tools = ((messages[1]?.result as Record<string, unknown>)?.tools ??
    []) as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'share_file');
});

async function runServer(input: string): Promise<string> {
  const child = spawn(process.execPath, [serverScriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  child.stdin.end(input);

  const [code] = await Promise.race([
    once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Timed out waiting for MCP server process to exit'));
      }, 5000);
    }),
  ]);

  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  assert.equal(code, 0, stderr || 'MCP server exited with a non-zero status');
  return Buffer.concat(stdoutChunks).toString('utf8');
}

function parseContentLengthMessages(output: string): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  let rest = output;

  while (rest.length > 0) {
    const separatorIndex = rest.indexOf('\r\n\r\n');
    assert.notEqual(separatorIndex, -1, 'Missing Content-Length header separator');

    const headerText = rest.slice(0, separatorIndex);
    const match = headerText.match(/Content-Length:\s*(\d+)/i);
    assert.ok(match, 'Missing Content-Length header');

    const contentLength = Number(match[1]);
    const bodyStart = separatorIndex + 4;
    const bodyEnd = bodyStart + contentLength;
    const body = rest.slice(bodyStart, bodyEnd);
    messages.push(JSON.parse(body) as Record<string, unknown>);
    rest = rest.slice(bodyEnd);
  }

  return messages;
}
