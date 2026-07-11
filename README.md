# NovaClaw

**A full coding & phone agent that runs entirely on your Android phone** — the
phone-native equivalent of Claude Code / Codex. NovaClaw ships an embedded Linux
(Termux bootstrap) + Node.js inside the APK, and runs its own agent there: it can
run shell commands, read/edit files, browse your storage, see images, and use
phone capabilities (camera, GPS, contacts, calendar) — all on-device, BYOK.

> **Status: working, signed APK, validated on real hardware** (OPPO CPH2557,
> Android 15, arm64). Installable by sideload — not on Google Play. Ships at
> `targetSdk 34`, running the embedded Linux under **proot** (bundled as a
> native lib) so it executes binaries without root and without depending on the
> old `targetSdk 28` trick. See [docs/PROOT_TARGETSDK.md](docs/PROOT_TARGETSDK.md).
> A legacy `targetSdk 28` build (direct exec) is still available as a fallback.

**Install:** see [docs/INSTALL.md](docs/INSTALL.md) (non-technical guide).

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
- **Approval gate** (`src/agent/safety.ts`) with an **allowlist (default-deny)**
  model: a shell command runs unattended only if every segment of the pipeline
  starts with a verified read-only/low-risk binary and the line has no command
  substitution, write redirection, or injection env vars. Anything else —
  deletes, installs, unrecognized binaries, `busybox rm`, `cp /dev/null`,
  `python -c`, chained `&&`/`;`/`|` with an unsafe segment — pauses for
  accept/reject. Same gate for writes outside the workspace or to critical files.
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
python scripts/fetch_proot_so.py                      # once: populate jniLibs with proot
pwsh scripts/build-android.ps1 -Arch arm64            # debug
pwsh scripts/build-android.ps1 -Arch arm64 -Release   # signed release
# output: android-native/app/build/outputs/apk/arm64/<debug|release>/
```

CI builds the release APK on every `vX.Y.Z` tag and attaches it to the GitHub
Release — see [.github/workflows/release.yml](.github/workflows/release.yml).

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

NovaClaw's own source is **MIT** (see [LICENSE](LICENSE)). The distributed APK
bundles third-party binaries (proot under GPLv2, the Termux bootstrap, Shizuku)
under their own licenses — see [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)
for the details and the GPL obligations that apply when you redistribute the APK.

For the distribution plan (open-source + niche strategy), see
[docs/DISTRIBUCION.md](docs/DISTRIBUCION.md).
