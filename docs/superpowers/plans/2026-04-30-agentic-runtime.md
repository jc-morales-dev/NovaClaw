# Agentic Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current chat-only behavior with an agent loop that can inspect files, run commands, and request approval for sensitive actions.

**Architecture:** Introduce a backend agent runtime with typed tool calls, model-action parsing, and approval gating. Keep the existing UI shell and only add the states needed to display tool runs and permission requests.

**Tech Stack:** Express, Vite, React, TypeScript, Node filesystem APIs, child process execution, Node assertions for lightweight tests

---

### Task 1: Extract agent runtime primitives

**Files:**
- Create: `src/agent/types.ts`
- Create: `src/agent/modelAction.ts`
- Create: `src/agent/safety.ts`
- Test: `tests/agent-model-action.test.mjs`
- Test: `tests/agent-safety.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add tests for:
- parsing a JSON `message` action
- parsing a JSON `tool_call` action
- rejecting malformed model output
- marking `terminal.run` with `ls` as safe
- marking `terminal.run` with `rm -rf tmp` as approval-required
- marking `file.write` as approval-required outside the current workspace

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/agent-model-action.test.mjs && node tests/agent-safety.test.mjs`
Expected: failures because the agent modules do not exist yet

- [ ] **Step 3: Write minimal implementation**

Create typed helpers for:
- parsed model actions
- model action extraction from raw text
- safety classification and approval message generation

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/agent-model-action.test.mjs && node tests/agent-safety.test.mjs`
Expected: PASS

### Task 2: Implement tool registry and runtime loop

**Files:**
- Create: `src/agent/tools.ts`
- Create: `src/agent/runtime.ts`
- Modify: `server.ts`
- Test: `tests/agent-runtime.test.mjs`

- [ ] **Step 1: Write the failing runtime test**

Add tests for:
- executing a safe `terminal.run` tool call and returning structured output
- pausing on a sensitive tool call and returning a pending approval object
- resuming after approval and continuing the loop

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/agent-runtime.test.mjs`
Expected: FAIL because runtime and tool registry are not implemented

- [ ] **Step 3: Write minimal implementation**

Implement:
- local terminal execution adapter
- file read/write/list/search helpers
- loop that alternates between model action and tool result
- hard iteration guard
- approval pause/resume support

- [ ] **Step 4: Integrate into the HTTP API**

Replace the current `/api/chat` flow with:
- session-aware agent execution
- structured response shape for `message`, `toolExecution`, and `approval`
- new approval endpoint to accept or reject pending requests

- [ ] **Step 5: Run tests to verify they pass**

Run: `node tests/agent-runtime.test.mjs`
Expected: PASS

### Task 3: Update frontend chat behavior

**Files:**
- Modify: `src/pages/ChatView.tsx`
- Modify: `src/translations.ts`

- [ ] **Step 1: Add failing UI-oriented assertions as backend contract checks**

Because the project does not have a frontend test harness, add explicit backend response fixtures in `tests/agent-runtime.test.mjs` that assert the shape expected by the chat UI:
- tool execution payload
- approval payload
- final assistant message payload

- [ ] **Step 2: Update the chat message model**

Add support for:
- approval request messages
- approval resolution buttons
- backend-delivered tool execution status

- [ ] **Step 3: Hook the new approval endpoint**

When the server returns a pending approval:
- render the explanation in chat
- show approve and reject actions
- call the approval endpoint
- append the resulting assistant/tool messages

- [ ] **Step 4: Preserve current UI language behavior**

Keep the existing layout and update only strings needed for:
- approval prompts
- approval accepted
- approval rejected
- execution failures

### Task 4: Verification and cleanup

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Add a repeatable verification command**

Add a script for the lightweight tests, for example:
- `test:agent`

- [ ] **Step 2: Document the new runtime behavior**

Update the README with:
- current prototype behavior
- available tools
- approval model
- limitation that Android-native runtime is not implemented in this repo yet

- [ ] **Step 3: Run full verification**

Run:
- `node tests/agent-model-action.test.mjs`
- `node tests/agent-safety.test.mjs`
- `node tests/agent-runtime.test.mjs`
- `npm.cmd run build`

Expected:
- all tests pass
- build succeeds

- [ ] **Step 4: Repository note**

This workspace is not currently a git repository, so commit steps are intentionally skipped until the project is initialized with git.
