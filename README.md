# NovaClaw

## Current Direction

- The React UI now talks through [`src/platform.ts`](./src/platform.ts) instead of calling page-level `/api/...` routes directly.
- The splash screen is now driven by real bootstrap state (`checking`, `not_installed`, `installing`, `ready`, `error`) instead of fake timer progress.
- The current Android target is a **self-contained embedded runtime APK**. The older Termux-bridge route should be treated as legacy reference material, not the final product direction.
- The remaining Android work is the embedded runtime manager, bundled runtime assets, and device QA.

Agentic coding assistant with an embedded Linux terminal and OpenCode
integration. The long-term vision is an Android APK that lets anyone use
a real coding agent from their phone. This repository contains:

- ✅ A **working web prototype** of the agent runtime.
- ✅ A hardened core (safety gate, embedded key scheme, context compaction).
- ✅ A **detailed migration plan and scaffold** for the Android APK.
- ❌ The final Android APK itself — this has to be built on top of the scaffold
  (see `docs/APK_MIGRATION_PLAN.md` and `android-shell/`).

> **Be honest about where you are standing.** Today this repo runs in a
> browser backed by a Node.js server. It is not yet installable on a
> phone as an APK. The work to get there is scoped in
> `docs/APK_MIGRATION_PLAN.md` (6–9 weeks for a mid-senior dev).

---

## What works today (web prototype)

- React chat UI with agent-style interactions (Home, Chat, Terminal, Settings, Logs).
- Agent loop driven by the configured remote model (MiniMax 2.5 via OpenCode Zen).
- Local tools: `terminal.run`, `file.read`, `file.write`, `file.list`,
  `file.search`, `workspace.mkdir`.
- Approval gate for sensitive actions (destructive shell commands, writes
  outside the workspace, writes to critical config files).
- 256 KB hard cap on `file.read` and automatic conversation compaction.
- Local heuristic fallback when the remote model is unreachable.
- Embedded API key scheme with XOR obfuscation and chunked storage
  (see `src/agent/embeddedKey.ts`).

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        NovaClaw                              │
├──────────────────────────────────────────────────────────────┤
│  Frontend (React)                                            │
│    pages/{Home,ChatView,TerminalView,Settings,LogViewer}     │
│    platform.ts  ← abstracts fetch() vs Capacitor plugins     │
├──────────────────────────────────────────────────────────────┤
│  Agent runtime (portable TypeScript)                         │
│    src/agent/                                                │
│      types.ts          Action contract                       │
│      modelAction.ts    JSON parser + repair                  │
│      safety.ts         Approval policy                       │
│      tools.ts          Tool registry + local executor        │
│      runtime.ts        Agent loop (approvals + compaction)   │
│      embeddedKey.ts    Obfuscated ZEN API key                │
├──────────────────────────────────────────────────────────────┤
│  Web adapter (today)          │  Capacitor adapter (future)  │
│  server.ts (Express + tsx)    │  android-shell/plugins/*.kt  │
└──────────────────────────────────────────────────────────────┘
```

## Environment

- `ZEN_API_KEY` — preferred in development. Takes precedence over the embedded key.
- `ZEN_BASE_URL` (optional, default `https://opencode.ai/zen/v1`).
- `ZEN_MODEL` (optional, default `minimax-m2.5-free`).

Resolution order at runtime:
1. `ZEN_API_KEY` env var (dev)
2. Embedded key in `src/agent/embeddedKey.ts` (production APK)
3. If neither is set → local heuristic fallback mode

### Embedding a key for a release build

```bash
npm run embed:key -- <YOUR_ZEN_API_KEY>          # embed key
npm run embed:key -- <YOUR_KEY> --rotate-seed    # also rotate the XOR seed
npm run embed:key:clear                          # remove embedded key
```

⚠️ **Obfuscation is not encryption.** An attacker with access to the compiled
bundle can recover the key with a few minutes of reverse engineering.
The recommended production approach is a lightweight proxy server that
owns the key and authenticates the APK with a short-lived install token.

## Run locally

```bash
npm install
npm run dev       # starts the prototype on http://localhost:3000
npm run build     # production build (vite + esbuild bundled server)
npm run start     # run the built server
npm run test:agent  # runtime + safety + parsing tests
```

## Security of sensitive actions

The safety gate (`src/agent/safety.ts`) classifies tool calls into
*safe* and *approval-required*. Approval is required when:

- A shell command matches destructive or privileged patterns
  (`rm`, `mv`, `curl`, `wget`, `chmod`, `sudo`, `sh -c`, redirections to
  system paths, etc).
- A `file.write` targets a path outside the workspace root.
- A `file.write` targets a critical config file (`server.ts`,
  `package.json`, lockfiles, `.env`, etc) even inside the workspace.
- A `workspace.mkdir` is outside the workspace root.

When approval is required, the agent **pauses** and the UI shows
accept/reject buttons. The agent only continues after a user decision.

## Limits of this repo

- This is **not** the final Android APK. `android-shell/` contains the
  scaffold and Kotlin plugin templates; you must run `npx cap add android`
  and wire them up (see `android-shell/README.md`).
- The local tools execute on whatever machine runs the dev server.
- The terminal is request/response — no PTY, no `vim`, no `tail -f`. That
  limitation is lifted in the Android build via `com.termux:terminal-emulator`.
- Endpoints are not authenticated. **Do not expose port 3000 publicly.**

## Roadmap

See [`docs/APK_MIGRATION_PLAN.md`](docs/APK_MIGRATION_PLAN.md). High level:

- **Phase A** — Extract `platform.ts`, build static. _(done)_
- **Phase B** — Termux executor plugin (Kotlin).
- **Phase C** — OpenCode installer plugin with progress UI.
- **Phase D** — Port agent runtime to Android (Kotlin or embedded JS engine).
- **Phase E** — Android Keystore for the ZEN key.
- **Phase F** — Real interactive terminal (PTY).
- **Phase G** — Build, sign, distribute.

## License

Private / unreleased.
