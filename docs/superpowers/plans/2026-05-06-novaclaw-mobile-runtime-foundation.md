# NovaClaw Mobile Runtime Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken APK transport path and introduce the shared bootstrap/runtime foundation needed for NovaClaw's self-contained Android runtime.

**Architecture:** Move all app pages behind a single platform client, add a real bootstrap status contract, and prepare the Android path to be driven by runtime state rather than simulated splash behavior or raw `/api` fetches.

**Tech Stack:** React, TypeScript, Capacitor, Express (web prototype), lightweight Node assertion tests

---

### Task 1: Add regression coverage for mobile transport and bootstrap state

**Files:**
- Create: `tests/platform-adapter.test.mjs`
- Create: `tests/bootstrap-state.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing tests**

Add tests that assert:
- platform helpers can normalize runtime/bootstrap status for the UI
- bootstrap state transitions expose blocked vs ready behavior
- mobile pages can consume typed platform responses instead of assuming raw `fetch().json()`

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/platform-adapter.test.mjs && node tests/bootstrap-state.test.mjs`
Expected: FAIL because the helper modules do not exist yet

- [ ] **Step 3: Write the minimal implementation**

Create small pure helpers for:
- bootstrap state normalization
- platform status guards
- shared status types reused by the app pages

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/platform-adapter.test.mjs && node tests/bootstrap-state.test.mjs`
Expected: PASS

### Task 2: Refactor UI pages to use the platform client

**Files:**
- Modify: `src/platform.ts`
- Modify: `src/pages/Home.tsx`
- Modify: `src/pages/ChatView.tsx`
- Modify: `src/pages/TerminalView.tsx`
- Modify: `src/pages/LogViewer.tsx`

- [ ] **Step 1: Extend the platform client surface**

Add typed methods for:
- runtime status
- bootstrap status
- logs fetch/clear
- install progress subscription if available

- [ ] **Step 2: Replace raw `/api/...` fetch usage**

Update the pages so they call the platform client instead of direct `/api` routes.

- [ ] **Step 3: Add graceful mobile-path error handling**

If a native capability is missing or not ready:
- render a clear in-app message
- do not throw raw JSON parse errors into chat

- [ ] **Step 4: Run focused verification**

Run: `npm.cmd run test:agent`
Expected: existing agent tests remain green after the refactor

### Task 3: Replace fake splash progress with bootstrap state wiring

**Files:**
- Create: `src/bootstrap/state.ts`
- Modify: `src/components/SplashScreen.tsx`
- Modify: `src/App.tsx`
- Modify: `src/platform.ts`

- [ ] **Step 1: Write the bootstrap state helper**

Define the canonical bootstrap phases and whether each one blocks app entry.

- [ ] **Step 2: Wire SplashScreen to real state**

Replace timer-only progress with platform-driven status:
- browser mode can exit quickly with a ready state
- mobile mode can stay open while the runtime installs

- [ ] **Step 3: Add retry and ready transitions**

Ensure the splash can:
- show current status text
- retry install after failure
- finish only when the runtime reports ready

- [ ] **Step 4: Run focused verification**

Run: `node tests/bootstrap-state.test.mjs`
Expected: PASS

### Task 4: Document the new runtime boundary and verify the repo

**Files:**
- Modify: `README.md`
- Modify: `docs/APK_MIGRATION_PLAN.md`

- [ ] **Step 1: Update docs to match the actual target**

Document that:
- the current work removes direct web assumptions from the APK
- the final target is an embedded runtime, not permanent Termux dependence
- bootstrap is now a real app concern

- [ ] **Step 2: Run full verification**

Run:
- `node tests/platform-adapter.test.mjs`
- `node tests/bootstrap-state.test.mjs`
- `npm.cmd run test:agent`
- `npm.cmd run build`

Expected:
- all tests pass
- build succeeds

- [ ] **Step 3: Review remaining gap list**

Capture what still remains for the full embedded runtime:
- runtime asset packaging
- extraction/install service
- local shell/file executor backed by embedded runtime
- Android-device QA
