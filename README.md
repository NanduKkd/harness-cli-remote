# Gemini Remote

Hooks-first remote control for Gemini CLI with:

- `host/`: a Fastify + TypeScript daemon that starts Gemini headless turns, persists session history in SQLite, ingests hook telemetry, and streams session events over WebSocket.
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

3. Install the Gemini hook bridge into each configured workspace:

```bash
cd /Users/nandakrishnan/applca/gemini-remote/host
npm run dev -- bootstrap --config ./config/local.json
```

This step is optional on the latest build because `serve` now auto-installs the bridge for every configured workspace on startup. It is still useful if you want to preinstall hooks before launching the daemon.

4. Start the daemon:

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

- Follow-up prompts use `gemini --resume <session-uuid> -p`.
- The host daemon uses Gemini hooks for telemetry only; it does not use ACP.
- Hook installation preserves existing hooks and appends the Gemini Remote bridge alongside them.
- If a workspace already has custom hooks, those hooks still run and can affect Gemini behavior.
