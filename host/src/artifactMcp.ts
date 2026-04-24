import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP_SERVER_NAME = 'gemini_remote_artifacts';
const GEMINI_SETTINGS_PATH = ['.gemini', 'settings.json'];
const MCP_SERVER_SCRIPT_PATH = fileURLToPath(
  new URL('../scripts/file-share-mcp-server.js', import.meta.url),
);

type GeminiSettingsShape = {
  mcpServers?: Record<
    string,
    {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }
  >;
};

export function getArtifactMcpServerName(): string {
  return MCP_SERVER_NAME;
}

export function getArtifactMcpServerScriptPath(): string {
  return MCP_SERVER_SCRIPT_PATH;
}

export function installGeminiArtifactMcp(rootPath: string): void {
  const settingsPath = path.join(rootPath, ...GEMINI_SETTINGS_PATH);
  mkdirSync(path.dirname(settingsPath), { recursive: true });

  const current = readGeminiSettings(settingsPath);
  const mcpServers = current.mcpServers ?? {};
  mcpServers[MCP_SERVER_NAME] = {
    command: 'node',
    args: [MCP_SERVER_SCRIPT_PATH],
    env: {
      REMOTE_DAEMON_URL: '${REMOTE_DAEMON_URL}',
      REMOTE_SESSION_ID: '${REMOTE_SESSION_ID}',
      REMOTE_RUN_ID: '${REMOTE_RUN_ID}',
      REMOTE_HOOK_TOKEN: '${REMOTE_HOOK_TOKEN}',
      REMOTE_WORKSPACE_ROOT: '${REMOTE_WORKSPACE_ROOT}',
    },
  };

  writeFileSync(
    settingsPath,
    `${JSON.stringify({ ...current, mcpServers }, null, 2)}\n`,
    'utf8',
  );
}

export function buildCodexArtifactMcpConfig(input: {
  daemonUrl: string;
  sessionId: string;
  runId: string;
  hookToken: string;
  workspaceRoot: string;
}): string[] {
  return [
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.command=${JSON.stringify('node')}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.args=${JSON.stringify([
      MCP_SERVER_SCRIPT_PATH,
    ])}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.env.REMOTE_DAEMON_URL=${JSON.stringify(
      input.daemonUrl,
    )}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.env.REMOTE_SESSION_ID=${JSON.stringify(
      input.sessionId,
    )}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.env.REMOTE_RUN_ID=${JSON.stringify(
      input.runId,
    )}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.env.REMOTE_HOOK_TOKEN=${JSON.stringify(
      input.hookToken,
    )}`,
    '-c',
    `mcp_servers.${MCP_SERVER_NAME}.env.REMOTE_WORKSPACE_ROOT=${JSON.stringify(
      input.workspaceRoot,
    )}`,
  ];
}

export function buildClaudeArtifactMcpConfig(input: {
  daemonUrl: string;
  sessionId: string;
  runId: string;
  hookToken: string;
  workspaceRoot: string;
}): string[] {
  return [
    '--mcp-config',
    JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: 'node',
          args: [MCP_SERVER_SCRIPT_PATH],
          env: {
            REMOTE_DAEMON_URL: input.daemonUrl,
            REMOTE_SESSION_ID: input.sessionId,
            REMOTE_RUN_ID: input.runId,
            REMOTE_HOOK_TOKEN: input.hookToken,
            REMOTE_WORKSPACE_ROOT: input.workspaceRoot,
          },
        },
      },
    }),
  ];
}

function readGeminiSettings(settingsPath: string): GeminiSettingsShape {
  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8')) as GeminiSettingsShape;
  } catch (error) {
    throw new Error(
      `Failed to parse ${settingsPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
