import type { WorkspaceConfig, WorkspaceRecord } from './types.js';
import { getCodexHookStatus, installCodexHooks } from './codexHookInstaller.js';
import { getGeminiHookStatus, installGeminiHooks } from './geminiHookInstaller.js';

export function installHooks(workspace: WorkspaceConfig): void {
  if (workspace.provider === 'codex') {
    installCodexHooks(workspace.rootPath);
    return;
  }

  installGeminiHooks(workspace.rootPath);
}

export function getHookStatus(
  workspace: WorkspaceConfig,
): WorkspaceRecord['hookStatus'] {
  if (workspace.provider === 'codex') {
    return getCodexHookStatus(workspace.rootPath);
  }

  return getGeminiHookStatus(workspace.rootPath);
}
