import { classifyToolCall } from './safety';
import { extractModelAction, tryParseJson, validateAction } from './modelAction';
import type { ToolCallLike, ToolExecutionResult } from './types';

type HistoryEntry = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

type PendingApproval = {
  toolCall: ToolCallLike;
  summary: string;
  reason: string;
};

export type AgentSession = {
  id: string;
  workspaceRoot: string;
  cwd: string;
  history: HistoryEntry[];
  pendingApproval: PendingApproval | null;
};

type MessageEvent = {
  type: 'message';
  message: string;
};

// B10: fragmento de texto de la respuesta en vivo (streaming token-por-token).
// La UI lo va appendeando a una burbuja "en curso"; el evento 'message' final la
// finaliza con el texto completo (así, si los deltas fallan, igual se ve bien).
type MessageDeltaEvent = {
  type: 'messageDelta';
  delta: string;
};

type ToolExecutionEvent = {
  type: 'toolExecution';
  toolExecution: ToolExecutionResult;
};

type ApprovalEvent = {
  type: 'approval';
  approval: PendingApproval;
};

export type TodoItem = { content: string; status: 'pending' | 'in_progress' | 'completed' };

type TodoEvent = {
  type: 'todo';
  todos: TodoItem[];
};

export type AgentRuntimeEvent = MessageEvent | MessageDeltaEvent | ToolExecutionEvent | ApprovalEvent | TodoEvent;

export type AgentEventSink = (event: AgentRuntimeEvent) => void;

/** Array de eventos que además notifica a un sink en cada push — así el server
 *  puede streamear los eventos al cliente EN VIVO mientras el turno avanza. */
export function trackedEvents(onEvent?: AgentEventSink): AgentRuntimeEvent[] {
  const arr: AgentRuntimeEvent[] = [];
  if (!onEvent) return arr;
  const originalPush = arr.push.bind(arr);
  arr.push = (...items: AgentRuntimeEvent[]) => {
    for (const item of items) {
      try {
        onEvent(item);
      } catch {
        // un sink roto nunca debe frenar al agente
      }
    }
    return originalPush(...items);
  };
  return arr;
}

type RuntimeResult = {
  events: AgentRuntimeEvent[];
};

type ModelCallInput = {
  systemPrompt: string;
  messages: HistoryEntry[];
  cwd: string;
  workspaceRoot: string;
};

type RuntimeOptions = {
  workspaceRoot: string;
  callModel: (input: ModelCallInput) => Promise<string>;
  executeToolCall?: (call: ToolCallLike, context: { cwd: string; workspaceRoot: string }) => Promise<ToolExecutionResult>;
  maxIterations?: number;
  maxParseRetries?: number;
};

const SYSTEM_PROMPT = `You are NovaClaw, an agentic coding assistant.
Reply using exactly one JSON object per turn.

Allowed actions:
1. {"kind":"message","message":"..."} — reply to the user with text (supports markdown).
2. {"kind":"tool_call","tool":"<tool_name>","arguments":{...}} — call a tool, then continue reasoning.

Available tools:

- terminal.run — execute a shell command.
  Arguments: {"command":"<shell command>"}
  Special handling: "pwd" returns cwd, "cd <dir>" changes cwd, "ls" lists files.
  Device control (Android): when Shizuku is connected, prefix a command with
  "shizuku " to run it with ADB shell privileges. Examples:
    shizuku input tap 500 800        (touch the screen)
    shizuku input swipe 500 1500 500 500 300
    shizuku input text "hello"
    shizuku screencap -p /sdcard/screen.png   (screenshot)
    shizuku pm list packages         (list installed apps)
    shizuku am start -n <pkg>/<activity>      (launch an app)
    shizuku dumpsys battery          (device state)
  If a shizuku command fails with a connection/permission error, tell the user to
  open Shizuku and grant NovaClaw permission.

- file.read — read a file's contents.
  Arguments: {"path":"<file_path>"}

- file.write — create or overwrite a file.
  Arguments: {"path":"<file_path>","content":"<file_content>"}

- file.list — list entries in a directory.
  Arguments: {"path":"<dir_path>"}

- file.search — search for files by name pattern recursively.
  Arguments: {"path":"<dir_path>","query":"<search_term>"}

- workspace.mkdir — create a directory tree.
  Arguments: {"path":"<dir_path>"}

- phone.location — get the phone's current GPS location.
  Arguments: {} (none). Returns latitude/longitude/accuracy AND a human-readable
  address when available: street, city, area, state, country, postalCode, address.
  When the user asks "where am I", answer in plain language using the address fields
  (e.g. "Estás en <street>, <city>, <state>, <country>") — do NOT just read out the
  raw latitude/longitude. Mention coordinates only if the user asks for them.
  Needs the Location connector enabled in Settings.

- phone.contacts — search the phone's contacts.
  Arguments: {"query":"<name or empty for all>"}. Returns matching name/number pairs.
  Needs the Contacts connector enabled in Settings.

- phone.photo — take a photo with the phone camera and save it as a file.
  Arguments: {"facing":"back"|"front"}. Returns the saved image path; read/analyze it
  afterwards with file tools. Needs the Camera connector enabled in Settings.

Phone access (connectors):
- The user can enable connectors in Settings → Connectors (files, camera, location,
  contacts, calendar, microphone). When the "files"/"full access" connector is on,
  the whole phone storage is reachable at /sdcard (a.k.a. /storage/emulated/0):
  /sdcard/Download, /sdcard/DCIM (photos), /sdcard/Documents, /sdcard/Pictures, etc.
  Use terminal.run with normal Unix tools to explore and manage it:
    find /sdcard -iname "*.pdf"           (find files)
    ls -la /sdcard/Download                (list a folder)
    du -sh /sdcard/DCIM                     (measure size)
    rm /sdcard/Download/old.zip             (delete — DESTRUCTIVE, confirm first)
  If a path under /sdcard fails with "Permission denied", tell the user to enable the
  Files connector in Settings → Connectors. Never delete or move a user file without
  explicitly confirming with the user first.

Installing tools / skills / MCP (on request):
- The Linux runtime has a package manager. When the user asks to install a tool by
  name or link, do it yourself with terminal.run:
    pkg install <name>                      (Termux packages: git, python, ffmpeg, ripgrep…)
    npm install -g <name>                   (Node CLIs)
    pip install <name>                      (Python packages, if python is installed)
    git clone <url> && cd <repo> && <build> (from a link)
  After installing, verify it (e.g. "<tool> --version") and report the result.
- MCP servers: you can install and launch an MCP server the user names or links
  (usually "npx -y <server>" or a git repo) so external tools become available.
- Skills: reusable instructions live under the workspace in a "skills" folder. You may
  read them with file.read and create new ones with file.write when the user teaches you
  a repeatable task.

Rules:
- Prefer tools over generic advice when the user asks to inspect files, run commands, create folders, or edit content.
- After a tool result, you MUST continue with another action (tool_call or message) — do not stop mid-task.
- If a tool fails, acknowledge the error and try a different approach.
- Reply in the same language the user writes in (Spanish by default for this user).
- For destructive actions (deleting/overwriting user files, uninstalling), confirm with the user before doing it.
- Do not wrap the JSON in explanations or code fences.
- Output ONLY the JSON object, nothing else.`;

const REPAIR_PROMPT = `Your previous response was not valid JSON or did not match the expected action format.
You MUST reply with exactly one JSON object. No explanations, no code fences.
Valid formats:
{"kind":"message","message":"..."}
{"kind":"tool_call","tool":"<tool_name>","arguments":{...}}

Try again:`;

// Hard limit on conversation history length to prevent context overflow.
// When exceeded, the oldest system (tool result) entries are summarized away,
// preserving the first user message and the last N turns verbatim.
const MAX_HISTORY_ENTRIES = 40;
const KEEP_RECENT_ENTRIES = 20;

export function compactHistoryIfNeeded(history: HistoryEntry[]): HistoryEntry[] {
  if (history.length <= MAX_HISTORY_ENTRIES) return history;

  const firstUser = history.find((entry) => entry.role === 'user');
  const recent = history.slice(-KEEP_RECENT_ENTRIES);
  const dropped = history.length - (firstUser ? 1 : 0) - recent.length;

  const summary: HistoryEntry = {
    role: 'system',
    content: JSON.stringify({
      kind: 'history_summary',
      note: `[Context compacted] ${dropped} earlier messages and tool results were omitted to stay within budget. Only the initial user request and the last ${KEEP_RECENT_ENTRIES} entries are preserved.`,
    }),
  };

  return firstUser ? [firstUser, summary, ...recent] : [summary, ...recent];
}

function toolResultToHistory(result: ToolExecutionResult): string {
  return JSON.stringify({
    tool: result.name,
    command: result.command,
    status: result.status,
    output: result.output,
    cwd: result.cwd,
  });
}

export function createAgentSession(id: string, workspaceRoot: string): AgentSession {
  return {
    id,
    workspaceRoot,
    cwd: workspaceRoot,
    history: [],
    pendingApproval: null,
  };
}

export function createAgentRuntime(options: RuntimeOptions) {
  const executeToolCall = options.executeToolCall ?? (async (call: ToolCallLike, context: { cwd: string; workspaceRoot: string }) => ({
    name: call.tool,
    command: JSON.stringify(call.arguments),
    status: 'error' as const,
    output: 'No tool executor was provided for this runtime.',
    cwd: context.cwd,
  }));
  const maxIterations = options.maxIterations ?? 10;
  const maxParseRetries = options.maxParseRetries ?? 2;

  async function callModelWithRepair(session: AgentSession): Promise<import('./types').AgentModelAction> {
    // Compact the running history before every model call so long sessions stay bounded.
    session.history = compactHistoryIfNeeded(session.history);

    for (let attempt = 0; attempt <= maxParseRetries; attempt += 1) {
      const messages = attempt === 0
        ? session.history
        : [...session.history, { role: 'system' as const, content: REPAIR_PROMPT }];

      const rawAction = await options.callModel({
        systemPrompt: SYSTEM_PROMPT,
        messages,
        cwd: session.cwd,
        workspaceRoot: session.workspaceRoot,
      });

      try {
        return extractModelAction(rawAction);
      } catch {
        if (attempt === maxParseRetries) {
          const parsed = tryParseJson(rawAction);
          if (parsed && typeof parsed === 'object') {
            const text = (parsed as Record<string, unknown>).message
              || (parsed as Record<string, unknown>).content
              || rawAction;
            return { kind: 'message', message: typeof text === 'string' ? text : rawAction };
          }
          return { kind: 'message', message: rawAction };
        }
      }
    }

    return { kind: 'message', message: 'Unable to get a valid response from the model.' };
  }

  async function continueLoop(session: AgentSession, events: AgentRuntimeEvent[] = []): Promise<RuntimeResult> {
    for (let i = 0; i < maxIterations; i += 1) {
      const action = await callModelWithRepair(session);

      if (action.kind === 'message') {
        session.history.push({ role: 'assistant', content: action.message });
        events.push({ type: 'message', message: action.message });
        return { events };
      }

      const decision = classifyToolCall(action, {
        cwd: session.cwd,
        workspaceRoot: session.workspaceRoot,
      });

      if (decision.requiresApproval) {
        session.pendingApproval = {
          toolCall: action,
          summary: decision.summary,
          reason: decision.reason,
        };

        events.push({
          type: 'approval',
          approval: session.pendingApproval,
        });

        return { events };
      }

      session.history.push({
        role: 'assistant',
        content: JSON.stringify(action),
      });

      const toolResult = await executeToolCall(action, {
        cwd: session.cwd,
        workspaceRoot: session.workspaceRoot,
      });

      if (toolResult.cwd) {
        session.cwd = toolResult.cwd;
      }

      session.history.push({
        role: 'system',
        content: toolResultToHistory(toolResult),
      });

      events.push({
        type: 'toolExecution',
        toolExecution: toolResult,
      });
    }

    const fallbackMessage = 'The agent exceeded the maximum number of steps. Please try a more specific request.';
    session.history.push({ role: 'assistant', content: fallbackMessage });
    events.push({ type: 'message', message: fallbackMessage });
    return { events };
  }

  async function runUserTurn(
    session: AgentSession,
    message: string,
    onEvent?: AgentEventSink,
    _signal?: AbortSignal,
    _mode?: 'plan' | 'build',
  ): Promise<RuntimeResult> {
    session.history.push({ role: 'user', content: message });
    return continueLoop(session, trackedEvents(onEvent));
  }

  async function resolveApproval(
    session: AgentSession,
    approved: boolean,
    onEvent?: AgentEventSink,
    _signal?: AbortSignal,
  ): Promise<RuntimeResult> {
    const events = trackedEvents(onEvent);

    if (!session.pendingApproval) {
      events.push({
        type: 'message',
        message: 'No pending action requires approval.',
      });
      return { events };
    }

    const pendingApproval = session.pendingApproval;
    session.pendingApproval = null;

    if (!approved) {
      session.history.push({
        role: 'system',
        content: `User rejected tool call: ${pendingApproval.summary}`,
      });
      return continueLoop(session, events);
    }

    session.history.push({
      role: 'assistant',
      content: JSON.stringify(pendingApproval.toolCall),
    });

    const toolResult = await executeToolCall(pendingApproval.toolCall, {
      cwd: session.cwd,
      workspaceRoot: session.workspaceRoot,
    });

    if (toolResult.cwd) {
      session.cwd = toolResult.cwd;
    }

    session.history.push({
      role: 'system',
      content: toolResultToHistory(toolResult),
    });

    events.push({
      type: 'toolExecution',
      toolExecution: toolResult,
    });
    return continueLoop(session, events);
  }

  return {
    runUserTurn,
    resolveApproval,
  };
}
