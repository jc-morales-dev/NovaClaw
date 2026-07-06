# Android Agent Runtime Design

**Goal:** Convert the current NovaClaw web prototype from a plain chat client into an agentic runtime whose behavior can later map onto an Android APK with an embedded local terminal runtime.

## Scope

This design covers the immediate implementation inside the current web project:

- A backend agent loop that can decide between replying normally, running a tool, or asking for approval.
- Local tool execution for terminal and filesystem actions so the web prototype behaves like an agent instead of a chatbot.
- Session state that preserves chat history, working directory, pending approvals, and tool results.
- Frontend support for approval requests and tool execution feedback without redesigning the existing UI.

This design does **not** implement the final Android-native embedded runtime yet. Instead, it defines the runtime contract that the Android runtime will later honor.

## Product Behavior

The agent must behave like a coding assistant, not a general conversational bot.

- It should inspect files, run commands, create directories, and write files when useful.
- It should continue reasoning after tool results come back.
- It should ask the user for approval before sensitive actions.
- It should explain what it plans to do when asking for approval.

Sensitive actions include destructive filesystem changes, overwriting files, package installation, large-impact shell commands, and any other command with meaningful side effects.

Safe actions include read-only inspection such as listing files, reading files, showing the current directory, and other non-destructive queries.

## Architecture

The implementation is split into four boundaries:

1. **Agent orchestrator**
   - Owns the loop between model output, tool execution, approval gating, and final response.
   - Receives a user message plus session state and returns one of:
     - final assistant message
     - tool execution event
     - approval request

2. **Tool registry**
   - Exposes a small fixed set of tools with typed inputs and consistent outputs.
   - Initial tools:
     - `terminal.run`
     - `file.read`
     - `file.write`
     - `file.list`
     - `file.search`
     - `workspace.mkdir`

3. **Safety policy**
   - Classifies tool requests as safe or approval-required.
   - Builds the approval text shown to the user.
   - Prevents execution of a sensitive tool until the user explicitly approves it.

4. **Frontend chat integration**
   - Renders normal assistant messages.
   - Renders tool execution cards.
   - Renders approval prompts with accept/reject actions.

## Model Contract

The current provider does not expose a tool-calling API in this project, so the model will be instructed to speak in strict JSON actions.

Allowed model actions:

- `message`
- `tool_call`

The backend will:

1. send the conversation plus tool instructions to the model
2. parse the JSON action
3. if it is a safe tool call, execute it and append the result
4. if it is a sensitive tool call, pause and ask the user for approval
5. if it is a final message, return that to the UI

The loop repeats until the model returns a final message or the runtime reaches a hard iteration limit.

## Session State

Each chat session needs:

- conversation history
- current working directory
- pending approval request, if any
- last tool results for traceability

This stays in server memory for now because the repo is still a prototype. The same state shape can later be stored in an Android local database or runtime service.

## Filesystem and Command Model

For the current web prototype, commands and file operations run on the local machine hosting the project. That gives us a working agent loop now.

The design intentionally treats that local executor as a replaceable runtime adapter. Later, the Android version can swap the executor implementation with an embedded APK runtime while keeping the tool contract unchanged.

## Error Handling

The agent must not fail silently.

- If model output is invalid JSON, the backend should retry with a repair prompt.
- If a tool fails, the error is returned to the model as structured tool output.
- If a pending approval is rejected, the model is told the action was rejected and must continue with a safer alternative or explain the limitation.
- If the model returns no usable content after retries, the user gets a clear failure message instead of `No se recibió respuesta del modelo`.

## Testing

Initial tests should focus on pure backend logic:

- parsing model actions
- classifying sensitive vs safe tool calls
- building approval prompts
- runtime loop behavior for safe tool calls and approval pauses

UI changes should stay minimal and only support the new backend states.

## Immediate Non-Goals

- Android-native packaged runtime
- storage permission UI for arbitrary phone folders
- user accounts or login
- sync across devices
- streaming token responses
- concurrent long-running background tasks

## Delivery Strategy

Phase 1 inside this repo:

- replace chat-only backend flow with an agent loop
- add tool execution and approval states
- keep the existing interface

Phase 2 outside this repo or in a later branch:

- swap the local machine executor with an embedded Android runtime
- extend storage permissions for phone folders
- add APK packaging and first-run runtime installation
