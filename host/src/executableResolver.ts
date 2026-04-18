import { accessSync, constants } from 'node:fs';
import path from 'node:path';

type ResolveExecutableOptions = {
  env?: NodeJS.ProcessEnv;
  envVar?: string;
  fallbackPaths?: string[];
};

export function resolveExecutable(
  command: string,
  options: ResolveExecutableOptions = {},
): string {
  const env = options.env ?? process.env;
  const override = options.envVar ? env[options.envVar]?.trim() : '';
  if (override) {
    return override;
  }

  const fromPath = findExecutableOnPath(command, env);
  if (fromPath) {
    return fromPath;
  }

  for (const fallbackPath of options.fallbackPaths ?? []) {
    if (isExecutable(fallbackPath)) {
      return fallbackPath;
    }
  }

  return command;
}

function findExecutableOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (command.includes(path.sep) || command.includes('/')) {
    return isExecutable(command) ? command : null;
  }

  const pathEntries = (env.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (pathEntries.length === 0) {
    return null;
  }

  const extensions = executableExtensions(env, command);

  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function executableExtensions(
  env: NodeJS.ProcessEnv,
  command: string,
): string[] {
  if (process.platform !== 'win32') {
    return [''];
  }

  const extension = path.extname(command);
  if (extension) {
    return [''];
  }

  return (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean);
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
