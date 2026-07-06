# NovaClaw Android Embedded Runtime Design

**Goal:** Convert NovaClaw from a mixed web prototype and Termux bridge into an Android APK that owns its first-run installation, local runtime bootstrap, agent transport, and on-device tool execution.

## Scope

This design covers the next practical slice of work inside the current repository:

- Stop the APK UI from calling web-only `/api/...` routes directly.
- Route all app behavior through a platform abstraction that can distinguish browser prototype vs Android APK runtime.
- Replace the fake first-launch splash progress with a real bootstrap contract for Android.
- Define the embedded runtime manager boundary that will later own package download, extraction, health checks, and local command execution.

This design does **not** finish the full embedded Linux runtime in one pass. It establishes the interfaces and app flow needed so that the runtime can be added without another UI rewrite.

## Product Constraints

The user requirements already established for NovaClaw are:

- The APK must be usable without requiring Termux as a separate app.
- The first run may download the runtime, but the user should not have to assemble it manually.
- The model may stay remote for V1, but terminal, files, and workspace behavior belong to the device runtime.
- Sensitive actions require explicit approval with a clear explanation of what will happen.
- The existing interface should be preserved; the work is about behavior, not redesign.

## Current State Problems

The repository currently has three conflicting execution paths:

1. **Web prototype path**
   - React pages call Express endpoints such as `/api/chat` and `/api/terminal`.
   - This works only when the local Node server is running beside the browser.

2. **Capacitor path**
   - `src/platform.ts` already defines a Capacitor adapter.
   - The pages do not use it, so the APK still behaves like a broken web client.

3. **Termux bridge path**
   - Android plugins call external Termux services to execute commands and install OpenCode.
   - That violates the target architecture because the APK is supposed to be self-contained.

## Target Architecture

NovaClaw should be split into four stable boundaries:

1. **UI layer**
   - Screens such as Home, Chat, Terminal, Logs, and first-run bootstrap.
   - The UI never decides whether work happens via Express, Capacitor, or an embedded runtime.
   - It talks only to a platform client.

2. **Platform client**
   - A TypeScript boundary that exposes app capabilities:
     - runtime status
     - bootstrap status
     - chat send/reset/approval
     - terminal execution
     - log retrieval
     - OpenCode or agent runtime install/start commands
   - Browser mode may still use the Express server for development.
   - APK mode must use Capacitor plugins or a local on-device bridge.

3. **Runtime manager**
   - Android-owned service/plugin responsible for:
     - checking whether the embedded runtime exists
     - downloading bootstrap assets on first launch
     - extracting/installing them into app-private storage
     - reporting progress and failure states
     - performing health checks
   - This replaces the fake splash installation.

4. **Agent execution runtime**
   - The actual local environment that can run shell commands and file tools.
   - In V1 this still talks to a remote model through the user's backend or provider path.
   - Tool execution remains local to the phone runtime.

## Phase Decomposition

The project is too large to complete safely as one undifferentiated patch, so it is split into four implementation phases:

### Phase 1: Mobile transport correction

- Replace raw `/api/...` fetch calls in the React pages with the platform abstraction.
- Make the APK capable of talking to its native/mobile path without trying to parse HTML as JSON.
- Keep the browser prototype working.

### Phase 2: Real bootstrap contract

- Add a bootstrap status model shared by UI and Android runtime manager.
- Replace simulated splash progress with actual runtime state and progress events.
- Expose install/check/retry primitives in the platform layer.

### Phase 3: Embedded runtime manager

- Replace external-Termux assumptions with an embedded runtime service.
- Add local installation directories, manifest/checksum validation, and health checks.
- Wire terminal and filesystem tools to that runtime.

### Phase 4: Production hardening

- Move model access fully behind the intended backend or secure native transport.
- Add storage access approvals, resumable bootstrap, logs, diagnostics, and APK QA.

## Data and Control Flow

### Browser prototype

`React page -> platform(web) -> Express API -> local runtime`

### Android APK after this migration

`React page -> platform(capacitor) -> Android plugin/service -> embedded runtime manager -> local runtime`

The important rule is that the page code must not know which path is active.

## Bootstrap UX

The first-launch experience should be driven by real state:

- `checking`
- `not_installed`
- `downloading`
- `extracting`
- `installing`
- `ready`
- `error`

The UI should be able to render:

- a short current step label
- percent when available
- retry action on failure
- entry into the main app only when the runtime is actually ready or the browser prototype mode explicitly bypasses bootstrap

## Error Handling

- If the APK calls a mobile capability that is unavailable, return a typed error instead of raw HTML or generic exceptions.
- If bootstrap fails, preserve the failure reason and allow retry.
- If the runtime is not yet ready, chat/terminal/open actions should surface a clear blocked state instead of silently failing.
- If the remote model fails, the error should stay distinct from runtime/bootstrap failures.

## Testing Strategy

Because the repository currently uses lightweight Node-based tests, the immediate verification focus should be:

- platform selection and adapter behavior
- bootstrap state helpers and transition rules
- regression tests for the chat/mobile transport bug

Build verification remains mandatory because these changes affect top-level app wiring.

## Non-Goals For This Slice

- Shipping the full embedded Linux image in this commit set
- Rewriting the UI design
- Implementing login/accounts
- Adding multi-device sync
- Replacing the entire backend model path in one pass

## Success Criteria

This slice is successful when:

- the APK no longer calls web-only JSON endpoints directly from its pages
- first-launch installation is modeled as real runtime state instead of a fake animation
- the codebase has a dedicated runtime/bootstrap boundary ready for the embedded runtime implementation
- the browser prototype still builds and tests cleanly
