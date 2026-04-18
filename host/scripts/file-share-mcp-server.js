#!/usr/bin/env node

const SERVER_NAME = 'gemini-remote-artifacts';
const SERVER_VERSION = '0.1.0';
const LATEST_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
]);
const TRANSPORT_CONTENT_LENGTH = 'content-length';
const TRANSPORT_JSONL = 'jsonl';

let buffer = Buffer.alloc(0);
let transportMode = null;

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainBuffer();
});

process.stdin.on('end', () => {
  process.exit(0);
});

process.stdin.resume();

function drainBuffer() {
  while (true) {
    if (!transportMode) {
      transportMode = detectTransport(buffer);
    }

    if (!transportMode) {
      return;
    }

    if (transportMode === TRANSPORT_JSONL) {
      const message = readJsonLineMessage();
      if (message === undefined) {
        return;
      }
      if (message !== null) {
        void handleMessage(message);
      }
      continue;
    }

    const message = readContentLengthMessage();
    if (message === undefined) {
      return;
    }
    if (message !== null) {
      void handleMessage(message);
    }
  }
}

function detectTransport(input) {
  const text = input.toString('utf8');
  const trimmed = text.trimStart();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return TRANSPORT_JSONL;
  }

  const separator = findHeaderSeparator(input);
  if (separator) {
    return TRANSPORT_CONTENT_LENGTH;
  }

  return null;
}

function parseContentLength(headerText) {
  const match = headerText.match(/Content-Length:\s*(\d+)/i);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

function findHeaderSeparator(input) {
  const crlfIndex = input.indexOf('\r\n\r\n');
  if (crlfIndex !== -1) {
    return { index: crlfIndex, length: 4 };
  }

  const lfIndex = input.indexOf('\n\n');
  if (lfIndex !== -1) {
    return { index: lfIndex, length: 2 };
  }

  return null;
}

function readContentLengthMessage() {
  const separator = findHeaderSeparator(buffer);
  if (!separator) {
    return undefined;
  }

  const headerText = buffer.slice(0, separator.index).toString('utf8');
  const contentLength = parseContentLength(headerText);
  if (contentLength == null) {
    buffer = Buffer.alloc(0);
    return null;
  }

  const messageStart = separator.index + separator.length;
  const messageEnd = messageStart + contentLength;
  if (buffer.length < messageEnd) {
    return undefined;
  }

  const body = buffer.slice(messageStart, messageEnd).toString('utf8');
  buffer = buffer.slice(messageEnd);
  return tryParseMessage(body);
}

function readJsonLineMessage() {
  while (true) {
    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex === -1) {
      return undefined;
    }

    const line = buffer.slice(0, newlineIndex).toString('utf8').trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) {
      continue;
    }

    return tryParseMessage(line);
  }
}

function tryParseMessage(raw) {
  try {
    return JSON.parse(raw);
  } catch (_error) {
    // Ignore malformed messages. The client will retry or fail the session.
    return null;
  }
}

async function handleMessage(message) {
  const { id, method, params } = message ?? {};

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'initialize') {
    sendResponse(id, {
      protocolVersion: selectProtocolVersion(params?.protocolVersion),
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    });
    return;
  }

  if (method === 'ping') {
    sendResponse(id, {});
    return;
  }

  if (method === 'tools/list') {
    sendResponse(id, {
      tools: [shareFileToolDefinition()],
    });
    return;
  }

  if (method === 'tools/call') {
    const result = await callTool(params);
    sendResponse(id, result);
    return;
  }

  if (typeof id !== 'undefined') {
    sendError(id, -32601, `Method not found: ${String(method)}`);
  }
}

function selectProtocolVersion(requestedVersion) {
  if (
    typeof requestedVersion === 'string' &&
    SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
  ) {
    return requestedVersion;
  }
  return LATEST_PROTOCOL_VERSION;
}

function shareFileToolDefinition() {
  return {
    name: 'share_file',
    description:
      'Share a file from the current workspace so the Gemini Remote mobile app can download it later.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path to a file inside the current workspace. Relative paths are resolved from the workspace root.',
        },
        title: {
          type: 'string',
          description:
            'Optional download filename to show in the mobile app. Defaults to the file basename.',
        },
        mimeType: {
          type: 'string',
          description: 'Optional MIME type override for the download.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  };
}

async function callTool(params) {
  const toolName = params?.name;
  if (toolName !== 'share_file') {
    return errorResult(`Unknown tool: ${String(toolName)}`);
  }

  const args = isRecord(params?.arguments) ? params.arguments : {};
  const filePath = readTrimmedString(args.path);
  if (!filePath) {
    return errorResult('The `path` argument is required.');
  }

  const daemonUrl = process.env.REMOTE_DAEMON_URL;
  const remoteSessionId = process.env.REMOTE_SESSION_ID;
  const remoteRunId = process.env.REMOTE_RUN_ID;
  const hookToken = process.env.REMOTE_HOOK_TOKEN;

  if (!daemonUrl || !remoteSessionId || !remoteRunId || !hookToken) {
    return errorResult(
      'This tool is only available inside an active Gemini Remote session.',
    );
  }

  try {
    const response = await fetch(new URL('/internal/artifacts', daemonUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hook-token': hookToken,
      },
      body: JSON.stringify({
        remoteSessionId,
        remoteRunId,
        path: filePath,
        title: readTrimmedString(args.title),
        mimeType: readTrimmedString(args.mimeType),
        requestedAt: new Date().toISOString(),
      }),
    });

    const body = await decodeJson(response);
    if (!response.ok) {
      return errorResult(
        readTrimmedString(body?.error) ||
          `Artifact registration failed with ${response.status}.`,
      );
    }

    return successResult(body);
  } catch (error) {
    return errorResult(
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function decodeJson(response) {
  const text = (await response.text()).trim();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return { raw: text };
  }
}

function successResult(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
    isError: false,
  };
}

function errorResult(message) {
  return {
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
    isError: true,
  };
}

function sendResponse(id, result) {
  sendMessage({
    jsonrpc: '2.0',
    id,
    result,
  });
}

function sendError(id, code, message) {
  sendMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  });
}

function sendMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (transportMode === TRANSPORT_JSONL) {
    process.stdout.write(`${body.toString('utf8')}\n`);
    return;
  }

  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readTrimmedString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
