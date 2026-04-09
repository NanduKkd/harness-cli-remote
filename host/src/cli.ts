import { loadConfig } from './config.js';
import { installHooks } from './hookInstaller.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  const [command = 'serve', ...args] = process.argv.slice(2);
  const configPath = readConfigPath(args);
  const config = loadConfig(configPath);

  if (command === 'bootstrap') {
    for (const workspace of config.workspaces) {
      installHooks(workspace);
      process.stdout.write(
        `Installed ${workspace.provider} hooks in ${workspace.rootPath}\n`,
      );
    }
    return;
  }

  if (command === 'serve') {
    await startServer(config);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function readConfigPath(args: string[]): string | undefined {
  const index = args.findIndex((value) => value === '--config');
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
