# Gemini Remote

Hooks-first remote control for Gemini CLI, Codex CLI, and Claude Code CLI with:

- `host/`: a Fastify + TypeScript daemon that starts Gemini, Codex, or Claude Code headless turns, persists session history and shared artifacts in SQLite, ingests hook telemetry, exposes artifact downloads, and streams session events over WebSocket.
- `app/`: a Flutter Android client that pairs with the host, lists workspaces, creates sessions, resumes conversations, shows live output, and cancels active runs.
- Session creation and follow-up prompts can carry an optional model override. The app stores the latest model per session, the host persists it on each run, and the provider CLIs receive it as `gemini --model <id>`, `codex -m <id>`, or `claude --model <id>`.

## Host setup

1. Install dependencies:

```bash
cd /Users/nandakrishnan/applca/gemini-remote/host
npm install
```

2. Review the host config:

- Edit [`host/config/local.json`](/Users/nandakrishnan/applca/gemini-remote/host/config/local.json) for your workspace list.
- Use [`host/config/example.json`](/Users/nandakrishnan/applca/gemini-remote/host/config/example.json) as the generic template.
- Set `"provider": "codex"` for Codex workspaces or `"provider": "claude"` for Claude Code workspaces. Omit `provider` to keep the legacy Gemini default.

3. Set the host pairing password:

```bash
export GEMINI_REMOTE_PAIRING_PASSWORD='choose-a-strong-password'
```

The daemon refuses to start if `GEMINI_REMOTE_PAIRING_PASSWORD` is missing.

4. Install the required CLIs for the workspaces you configured:

- Gemini workspaces need `gemini` on `PATH`.
- Codex workspaces look for `CODEX_BIN`, then `PATH`, then common macOS install locations such as `/Applications/Codex.app/Contents/Resources/codex`. Sign in once locally or provide Codex auth the same way you normally run `codex exec`.
- Claude workspaces look for `CLAUDE_BIN`, then `PATH`, then common local install locations such as `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, or `/usr/local/bin/claude`. Sign in once locally or provide Claude auth the same way you normally run `claude -p`.

5. Install the workspace hook bridges into each configured workspace:

```bash
cd /Users/nandakrishnan/applca/gemini-remote/host
npm run dev -- bootstrap --config ./config/local.json
```

This step is optional on the latest build because `serve` now auto-installs the bridge for every configured workspace on startup. It is still useful if you want to preinstall hooks before launching the daemon.

For Gemini workspaces this also writes a project-local MCP server entry that exposes the `share_file` tool used for mobile artifact sharing. Codex and Claude workspaces receive that same MCP server through per-run CLI config instead of a persistent workspace file edit.

6. Start the daemon:

```bash
cd /Users/nandakrishnan/applca/gemini-remote/host
npm run dev -- serve --config ./config/local.json
```

The daemon uses `GEMINI_REMOTE_PAIRING_PASSWORD` for initial pairing with the Android app.

If you installed the macOS LaunchDaemon from [`host/scripts/install-launchdaemon.sh`](/Users/nandakrishnan/applca/gemini-remote/host/scripts/install-launchdaemon.sh), rebuild and restart it with:

```bash
cd /Users/nandakrishnan/applca/gemini-remote/host
sudo ./scripts/restart-launchdaemon.sh
```

## Android app setup

1. Install Flutter dependencies:

```bash
cd /Users/nandakrishnan/applca/gemini-remote/app
flutter pub get
```

2. Run the app on an emulator or device:

```bash
cd /Users/nandakrishnan/applca/gemini-remote/app
flutter run
```

3. On the Pair screen, enter the host URL, for example `http://<host-lan-ip>:8918`, plus the same password you set in `GEMINI_REMOTE_PAIRING_PASSWORD`.

## Verification

- Host typecheck: `cd /Users/nandakrishnan/applca/gemini-remote/host && npm run typecheck`
- Host build: `cd /Users/nandakrishnan/applca/gemini-remote/host && npm run build`
- Flutter analyze: `cd /Users/nandakrishnan/applca/gemini-remote/app && flutter analyze`
- Flutter tests: `cd /Users/nandakrishnan/applca/gemini-remote/app && flutter test`

## Notes

- Follow-up prompts use `gemini --resume <session-uuid> -p` for Gemini workspaces, `codex exec resume <thread-id>` for Codex workspaces, and `claude --resume <session-id> -p` for Claude workspaces.
- The host daemon uses Gemini hooks for Gemini telemetry, `codex exec --json` plus a Codex `SessionStart` hook for Codex telemetry, and Claude project hooks plus `claude -p --output-format json` for Claude telemetry.
- Hook installation preserves existing hooks and appends the provider-specific Gemini Remote bridge alongside them.
- Gemini workspaces get a project-local MCP server entry in `.gemini/settings.json` for the `share_file` tool. Codex and Claude workspaces receive the same MCP server via per-run CLI config overrides instead of a persistent workspace config edit.
- Shared artifacts are copied into the host data directory before download, so the mobile app receives a stable snapshot rather than a live workspace path.
- If a workspace already has custom hooks, those hooks still run and can affect Gemini, Codex, or Claude Code behavior.
