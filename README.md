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
- Agent loop with NATIVE function-calling (like Claude Code/Codex), extended
  thinking for Claude models, and an engineering methodology system prompt
  (explore → surgical edit → verify).
- Tools: `terminal.run`, `file.read`, `file.edit` (surgical old→new replacement),
  `file.write`, `file.grep` (content search), `file.list`, `file.search`,
  `workspace.mkdir`, `web.fetch` (read docs/APIs), `subagent.run` (delegate
  self-contained subtasks to a fresh sub-agent), plus phone tools
  (`phone.location`, `phone.contacts`, `phone.photo`).
- Project memory: a `NOVACLAW.md` at the workspace root is injected into the
  system prompt every turn (like CLAUDE.md) and the agent maintains it.
- Approval gate for sensitive actions (destructive shell commands, writes/edits
  outside the workspace, writes to critical config files).
- 256 KB hard cap on `file.read` and automatic conversation compaction.
- Local heuristic fallback when the remote model is unreachable.
- **BYOK (bring your own key)**: the user provides their own API key in
  Settings. Keys are never embedded in the binary — on Android they live in
  the Keystore, on the server in `novaclaw.config.json` (outside git).

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
│      nativeAgent.ts    Agent loop (NATIVE function-calling)  │
│      modelClient.ts    Provider client (OpenAI + Anthropic)  │
│      toolSchemas.ts    Native tool definitions               │
│      providers.ts      BYOK provider registry                │
│      safety.ts         Approval policy                       │
│      tools.ts          Tool registry + local executor        │
│      runtime.ts        Legacy JSON loop (no-key fallback)    │
│      modelAction.ts    JSON parser + repair (fallback only)  │
├──────────────────────────────────────────────────────────────┤
│  Web adapter (today)          │  Capacitor adapter (future)  │
│  server.ts (Express + tsx)    │  android-shell/plugins/*.kt  │
└──────────────────────────────────────────────────────────────┘
```

## Environment

- `ZEN_API_KEY` — development only. In production the user brings their own key.
- `ZEN_BASE_URL` (optional, default `https://opencode.ai/zen/v1`).
- `ZEN_MODEL` (optional, default `claude-haiku-4-5`).

Resolution order at runtime (BYOK):
1. `ZEN_API_KEY` env var (dev/CI; on Android, RuntimeManager injects it from the config)
2. `novaclaw.config.json` — what the user saved from Settings (outside git)
3. If neither is set → local heuristic fallback mode

**There is no embedded key.** Distributing an APK with a baked-in API key is
trivially reversible and would let anyone drain the quota. Each user provides
their own key (OpenRouter, Zen, NVIDIA, Anthropic, OpenAI) in Settings; on
Android it is stored in the Keystore, never in the JS bundle.

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
