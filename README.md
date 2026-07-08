# NovaClaw

**A full coding & phone agent that runs entirely on your Android phone** — the
phone-native equivalent of Claude Code / Codex. NovaClaw ships an embedded Linux
(Termux bootstrap) + Node.js inside the APK, and runs its own agent there: it can
run shell commands, read/edit files, browse your storage, see images, and use
phone capabilities (camera, GPS, contacts, calendar) — all on-device, BYOK.

> **Status: working, signed APK, validated on real hardware** (OPPO CPH2557,
> Android 15, arm64). Installable by sideload — not on Google Play, because it
> targets `targetSdk 28` on purpose so it can execute binaries without root.

---

## What it does

- **On-device agent** with NATIVE function-calling (like Claude Code/Codex):
  explore → surgical edit → verify. Extended/interleaved thinking for Claude
  models. Streams each step live (SSE); gives **one consolidated final answer**
  instead of chatty intermediate messages.
- **Tools:** `terminal_run`, `file_read` (line-numbered, ranged), `file_edit`
  (surgical old→new), `file_write`, `file_grep`, `file_list`, `file_search`,
  `workspace_mkdir`, `web_fetch`, `image_view` (vision), `subagent_run`,
  `todo_write` (live task plan), and phone tools: `phone_location`,
  `phone_contacts`, `phone_calendar`, `phone_photo` (takes a picture **and**
  sees it).
- **Phone connectors:** enable Files / Camera / Location / Contacts / Calendar
  from Settings; each maps to a real Android permission.
- **Real PTY terminal** over WebSocket (`vim`, `htop`, `tail -f` work).
- **Multi-conversation history**, rewind/edit, stop button, project memory
  (`NOVACLAW.md` injected into the system prompt, like `CLAUDE.md`).
- **BYOK (bring your own key):** the user provides their own model API key
  (OpenRouter, Zen, NVIDIA, Anthropic, OpenAI). **No key is ever embedded** in
  the binary.

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  APK (android-native/, targetSdk 28, arm64)                   │
│                                                               │
│  MainActivity ─ loads WebView → http://127.0.0.1:8088         │
│  NovaClawService (foreground) ─ owns the Node agent process   │
│  RuntimeManager ─ installs Termux bootstrap + Node, runs agent│
│  NativeToolsServer (127.0.0.1:8099) ─ camera/GPS/contacts/cal │
│  ConnectorBridge ─ window.NovaClawNative (permissions)        │
│  TokenStore ─ per-install secret shared with the agent        │
├───────────────────────────────────────────────────────────────┤
│  Agent (Node, bundled to agent.cjs, runs inside embedded Linux)│
│    server.ts ─ Express on 127.0.0.1:8088 (token-gated) + PTY  │
│    src/agent/nativeAgent.ts ─ agent loop (native tool-calling)│
│    src/agent/modelClient.ts ─ OpenAI + Anthropic client       │
│    src/agent/tools.ts ─ tool executor                         │
│    src/agent/safety.ts ─ approval policy                      │
├───────────────────────────────────────────────────────────────┤
│  Frontend (React) ─ served by the agent; platform.ts fetches │
│    /api with the injected token (X-Nova-Token)                │
└───────────────────────────────────────────────────────────────┘
```

The React UI, the agent, and the tools are portable TypeScript. On the phone the
UI runs in a WebView and talks to the local agent over HTTP; a browser/PC dev
mode (`npm run dev`) runs the same agent behind Express.

## Security model

The agent can run arbitrary code and touch the phone, so it is locked down:

- **Loopback only.** The agent (`127.0.0.1:8088`) and the native tools server
  (`127.0.0.1:8099`) bind to loopback — never to the network. No device on your
  Wi-Fi can reach them.
- **Token auth.** A random per-install token (`TokenStore`) is required on every
  `/api/*` call, on the `/pty` WebSocket, and on the native tools server. The
  agent injects it into the served HTML; other apps on the phone don't have it.
- **Approval gate** (`src/agent/safety.ts`) for destructive/privileged shell
  (`rm`, `mv`, `chmod`, `sudo`, package installs, interpreter inline code like
  `python -c` / `node -e`, `find -delete`, `truncate`, redirections to
  `/sdcard` or system paths, `pm`/`settings`, …), writes outside the workspace,
  and writes to critical config files. The agent pauses for accept/reject.
- **Secret protection.** `file_read`/`file_grep` refuse to read files holding
  secrets (`novaclaw.config.json`, `*.jks`, …). `web_fetch` blocks loopback and
  private IP ranges (SSRF protection).
- **App hardening.** `allowBackup=false`, cleartext restricted to loopback
  (network security config), WebView with no file/content access and external
  links opened in the system browser. Release builds are non-debuggable.

## Build

```bash
# Web/PC dev (same agent behind Express)
npm install
npm run dev            # http://localhost:3000
npm test               # tsc-checked test suites

# Android APK (Windows / PowerShell)
pwsh scripts/build-android.ps1 -Arch arm64            # debug
pwsh scripts/build-android.ps1 -Arch arm64 -Release   # signed release
# output: android-native/app/build/outputs/apk/arm64/<debug|release>/
```

Release signing uses `android-native/keystore.properties` +
`novaclaw-release.jks` (both outside git). **Keep the keystore safe** — every
update must be signed with the same key.

## Install (sideload)

1. Download the APK from Releases (or build it).
2. Enable "install from unknown sources" on the phone.
3. Install. First launch downloads the base system once (~300 MB: Linux + Node).
4. Open Settings → AI Model and paste your own API key (BYOK).

Requires Android 8+ arm64.

## License

Private / unreleased.
