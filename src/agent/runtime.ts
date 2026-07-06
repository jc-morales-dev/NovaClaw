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

type ToolExecutionEvent = {
  type: 'toolExecution';
  toolExecution: ToolExecutionResult;
};

type ApprovalEvent = {
  type: 'approval';
  approval: PendingApproval;
};

export type AgentRuntimeEvent = MessageEvent | ToolExecutionEvent | ApprovalEvent;

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

Rules:
- Prefer tools over generic advice when the user asks to inspect files, run commands, create folders, or edit content.
- After a tool result, you MUST continue with another action (tool_call or message) — do not stop mid-task.
- If a tool fails, acknowledge the error and try a different approach.
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

function compactHistoryIfNeeded(history: HistoryEntry[]): HistoryEntry[] {
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

  async function runUserTurn(session: AgentSession, message: string): Promise<RuntimeResult> {
    session.history.push({ role: 'user', content: message });
    return continueLoop(session, []);
  }

  async function resolveApproval(session: AgentSession, approved: boolean): Promise<RuntimeResult> {
    if (!session.pendingApproval) {
      return {
        events: [
          {
            type: 'message',
            message: 'No pending action requires approval.',
          },
        ],
      };
    }

    const pendingApproval = session.pendingApproval;
    session.pendingApproval = null;

    if (!approved) {
      session.history.push({
        role: 'system',
        content: `User rejected tool call: ${pendingApproval.summary}`,
      });
      return continueLoop(session, []);
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

    return continueLoop(session, [
      {
        type: 'toolExecution',
        toolExecution: toolResult,
      },
    ]);
  }

  return {
    runUserTurn,
    resolveApproval,
  };
}
