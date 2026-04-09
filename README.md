# Gemini Remote

Hooks-first remote control for Gemini CLI and Codex CLI with:

- `host/`: a Fastify + TypeScript daemon that starts Gemini or Codex headless turns, persists session history in SQLite, ingests hook telemetry, and streams session events over WebSocket.
- `app/`: a Flutter Android client that pairs with the host, lists workspaces, creates sessions, resumes conversations, shows live output, and cancels active runs.

## Host setup

1. Install dependencies:

```bash
cd /Users/nandakrishnan/applca/gemini-remote/host
npm install
```

2. Review the host config:

- Edit [`host/config/local.json`](/Users/nandakrishnan/applca/gemini-remote/host/config/local.json) for your workspace list.
- Use [`host/config/example.json`](/Users/nandakrishnan/applca/gemini-remote/host/config/example.json) as the generic template.
- Set `"provider": "codex"` for Codex workspaces. Omit `provider` to keep the legacy Gemini default.

3. Install the required CLIs for the workspaces you configured:

- Gemini workspaces need `gemini` on `PATH`.
- Codex workspaces need `codex` on `PATH`. Sign in once locally or provide Codex auth the same way you normally run `codex exec`.

4. Install the workspace hook bridges into each configured workspace:

```bash
cd /Users/nandakrishnan/applca/gemini-remote/host
npm run dev -- bootstrap --config ./config/local.json
```

This step is optional on the latest build because `serve` now auto-installs the bridge for every configured workspace on startup. It is still useful if you want to preinstall hooks before launching the daemon.

5. Start the daemon:

```bash
cd /Users/nandakrishnan/applca/gemini-remote/host
npm run dev -- serve --config ./config/local.json
```

The daemon prints a pairing code on startup. Enter that code in the Android app.

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

3. On the Pair screen, enter the host URL, for example `http://<host-lan-ip>:8918`, plus the pairing code from the daemon.

## Verification

- Host typecheck: `cd /Users/nandakrishnan/applca/gemini-remote/host && npm run typecheck`
- Host build: `cd /Users/nandakrishnan/applca/gemini-remote/host && npm run build`
- Flutter analyze: `cd /Users/nandakrishnan/applca/gemini-remote/app && flutter analyze`
- Flutter tests: `cd /Users/nandakrishnan/applca/gemini-remote/app && flutter test`

## Notes

- Follow-up prompts use `gemini --resume <session-uuid> -p` for Gemini workspaces and `codex exec resume <thread-id>` for Codex workspaces.
- The host daemon uses Gemini hooks for Gemini telemetry and `codex exec --json` plus a Codex `SessionStart` hook for Codex telemetry.
- Hook installation preserves existing hooks and appends the provider-specific Gemini Remote bridge alongside them.
- If a workspace already has custom hooks, those hooks still run and can affect Gemini or Codex behavior.
