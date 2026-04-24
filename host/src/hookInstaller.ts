import { installGeminiArtifactMcp } from './artifactMcp.js';
import { getClaudeHookStatus, installClaudeHooks } from './claudeHookInstaller.js';
import type { WorkspaceConfig, WorkspaceRecord } from './types.js';
import { getCodexHookStatus, installCodexHooks } from './codexHookInstaller.js';
import { getGeminiHookStatus, installGeminiHooks } from './geminiHookInstaller.js';

export function installHooks(workspace: WorkspaceConfig): void {
  if (workspace.provider === 'codex') {
    installCodexHooks(workspace.rootPath);
    return;
  }

  if (workspace.provider === 'claude') {
    installClaudeHooks(workspace.rootPath);
    return;
  }

  installGeminiHooks(workspace.rootPath);
  installGeminiArtifactMcp(workspace.rootPath);
}

export function getHookStatus(
  workspace: WorkspaceConfig,
): WorkspaceRecord['hookStatus'] {
  if (workspace.provider === 'codex') {
    return getCodexHookStatus(workspace.rootPath);
  }

  if (workspace.provider === 'claude') {
    return getClaudeHookStatus(workspace.rootPath);
  }

  return getGeminiHookStatus(workspace.rootPath);
}
