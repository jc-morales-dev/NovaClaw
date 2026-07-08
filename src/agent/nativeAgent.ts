/**
 * Runtime del agente con function-calling NATIVO. Reemplaza al protocolo casero
 * de "un JSON por turno": ahora el modelo llama herramientas de verdad (como
 * Codex/Claude Code), lo que lo hace mucho más confiable y capaz de encadenar
 * pasos. Mantiene la misma interfaz de eventos y la sesión persistible.
 */
import { classifyToolCall } from './safety';
import { callModelWithTools, type AgentMessage } from './modelClient';
import { TOOL_NAME_TO_DOT } from './toolSchemas';
import { trackedEvents, type AgentEventSink } from './runtime';
import type { AgentSession, AgentRuntimeEvent } from './runtime';
import type { ToolCallLike, ToolExecutionResult } from './types';

export const NATIVE_SYSTEM_PROMPT = `You are NovaClaw, an autonomous software-engineering and phone assistant that runs ENTIRELY on the user's Android phone, inside an embedded Linux. You are the phone-native equivalent of Claude Code / Codex: same discipline, same rigor.

You have native tools. Call them to act — never describe what you would do, just do it, then explain the result.

# Engineering methodology (follow this on every coding task)

1. EXPLORE before acting. Never guess where code lives:
   - file_grep to find WHERE something is defined/used (search by content, regex).
   - file_search / file_list to map the project structure.
   - file_read to understand the code before touching it.
2. EDIT surgically:
   - For existing files ALWAYS prefer file_edit (exact old_string → new_string). Copy the snippet EXACTLY from file_read output (whitespace matters) and include enough surrounding lines to be unique.
   - Use file_write only for NEW files or intentional full rewrites.
   - Never rewrite a whole file to change a few lines.
3. VERIFY after changing:
   - Run the code (terminal_run: node script.js, python x.py, npm test…) and read the output.
   - If it fails, read the error, fix it, and run again. Iterate until it works.
   - Never claim something works without having run it.
4. For big explorations or self-contained side tasks, delegate to subagent_run so this conversation stays focused. Give the sub-agent EVERY detail it needs (it knows nothing about this chat).

# Capabilities

- Shell (terminal_run): any command in the embedded Linux (397+ binaries). Install tools on request: pkg install X, npm install -g X, pip install X, git clone. With the Files connector on, the whole phone storage is at /sdcard (Download, DCIM photos, Documents…).
- Files: file_read, file_edit (surgical), file_write, file_grep (content search), file_list, file_search (name search), workspace_mkdir.
- Web (web_fetch): read documentation, APIs or any http(s) page as text. Use it when you need current information or library docs.
- Phone: phone_location (returns a human address — answer in plain language, e.g. "Estás en <street>, <city>, <country>", never raw coordinates), phone_contacts, phone_photo.
- Sub-agents (subagent_run): a fresh agent with clean context that reports back.

# Project memory

- If a "Project memory" section appears below, it is persistent knowledge about this workspace (like CLAUDE.md). Respect it.
- When the user states a lasting preference, decision or fact worth remembering ("siempre usá X", "el proyecto se llama Y"), persist it: update the NOVACLAW.md file at the workspace root (file_edit if it exists, file_write if not). Keep it short and organized.

# Rules

- Be autonomous: chain as many tool calls as needed to FINISH the task before replying. Do not stop halfway to ask "should I continue?".
- Reply in the user's language (Spanish by default for this user).
- Destructive or sensitive actions (deleting files, installing packages, touching files outside the workspace) trigger a user-approval dialog — that's expected, proceed with the call.
- Never invent file contents, command output, or API responses. If you didn't run it, say so.
- When done, give a concise, useful answer in markdown. Lead with the result, not the process.`;

// El subagente: mismo poder, contexto limpio, sin aprobaciones ni sub-subagentes.
const SUBAGENT_SYSTEM_PROMPT = `You are a NovaClaw sub-agent running on the user's Android phone (embedded Linux). You receive ONE self-contained task and must complete it autonomously with your tools (terminal_run, file_read, file_edit, file_write, file_grep, file_list, file_search, workspace_mkdir, web_fetch, phone tools).

Rules:
- Explore with file_grep/file_read before editing; edit surgically with file_edit; verify by running code when applicable.
- You CANNOT perform approval-gated actions (deleting files, installing packages, writing outside the workspace). If the task needs one, note it in your report instead.
- Your FINAL message is your report to the main agent: make it complete, factual and concise. Include paths, line numbers and exact findings.`;

type RuntimeResult = { events: AgentRuntimeEvent[] };

type ConfigSnapshot = { providerId: string; apiKey: string; model: string };

interface NativeRuntimeOptions {
  workspaceRoot: string;
  getConfig: () => ConfigSnapshot;
  executeToolCall: (call: ToolCallLike, ctx: { cwd: string; workspaceRoot: string }) => Promise<ToolExecutionResult>;
  onRemote?: (label: string) => void;
  maxIterations?: number;
  /** Memoria persistente del proyecto (NOVACLAW.md) — se inyecta al system prompt. */
  getProjectContext?: () => Promise<string> | string;
}

// Estado de reanudación tras una aprobación (se guarda en la sesión, serializable).
interface NativeResume {
  messages: AgentMessage[];
  batch: Array<{ id: string; name: string; args: Record<string, any> }>;
  nextIndex: number;
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

/** Reconstruye el contexto de mensajes para el modelo a partir del historial
 *  visible de la sesión (turnos previos como texto). */
function buildBaseMessages(session: AgentSession): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const entry of session.history) {
    if (entry.role === 'user') {
      out.push({ role: 'user', text: entry.content });
    } else if (entry.role === 'assistant') {
      out.push({ role: 'assistant', text: entry.content });
    } else if (entry.role === 'system') {
      // Resultado de herramienta de un turno anterior → nota para el modelo.
      out.push({ role: 'user', text: `[tool result] ${entry.content}` });
    }
  }
  return out;
}

export function createNativeAgentRuntime(options: NativeRuntimeOptions) {
  const maxIterations = options.maxIterations ?? 32;

  function dotName(nativeName: string): string {
    return TOOL_NAME_TO_DOT[nativeName] ?? nativeName;
  }

  /** System prompt del turno: base + memoria persistente del proyecto si existe. */
  async function buildSystemPrompt(): Promise<string> {
    let system = NATIVE_SYSTEM_PROMPT;
    try {
      const ctx = await options.getProjectContext?.();
      if (ctx && ctx.trim()) {
        system += `\n\n# Project memory (NOVACLAW.md)\n${ctx.trim().slice(0, 8000)}`;
      }
    } catch {
      // sin memoria de proyecto — seguimos con el prompt base
    }
    return system;
  }

  /** Ejecuta una subtarea en un agente hijo con contexto limpio y devuelve su reporte. */
  async function runSubagentTask(task: string): Promise<string> {
    const cfg = options.getConfig();
    const messages: AgentMessage[] = [{ role: 'user', text: task }];
    const SUB_MAX_ITERATIONS = 12;

    for (let i = 0; i < SUB_MAX_ITERATIONS; i += 1) {
      let reply;
      try {
        reply = await callModelWithTools({
          providerId: cfg.providerId,
          apiKey: cfg.apiKey,
          model: cfg.model,
          system: SUBAGENT_SYSTEM_PROMPT,
          messages,
          excludeTools: ['subagent_run'],
        });
      } catch (error: any) {
        return `[Sub-agente falló: ${error?.message ?? 'error de modelo'}]`;
      }

      if (!reply.toolCalls || reply.toolCalls.length === 0) {
        return reply.text ?? '(el sub-agente no devolvió reporte)';
      }

      messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls, rawContent: reply.rawContent });

      for (const tc of reply.toolCalls) {
        const call: ToolCallLike = { tool: dotName(tc.name), arguments: tc.args };
        const decision = classifyToolCall(call, {
          cwd: options.workspaceRoot,
          workspaceRoot: options.workspaceRoot,
        });
        let output: string;
        if (decision.requiresApproval) {
          output = 'BLOCKED: this action needs user approval and sub-agents cannot request it. Report it back so the main agent can do it.';
        } else {
          try {
            const result = await options.executeToolCall(call, {
              cwd: options.workspaceRoot,
              workspaceRoot: options.workspaceRoot,
            });
            output = result.output;
          } catch (error: any) {
            output = error?.message ?? 'Tool failed.';
          }
        }
        messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, result: output });
      }
    }
    return '[El sub-agente alcanzó su límite de pasos sin terminar el reporte.]';
  }

  async function runLoop(
    session: AgentSession,
    messages: AgentMessage[],
    events: AgentRuntimeEvent[],
  ): Promise<RuntimeResult> {
    const cfg = options.getConfig();
    const system = await buildSystemPrompt();

    for (let i = 0; i < maxIterations; i += 1) {
      let reply;
      try {
        reply = await callModelWithTools({
          providerId: cfg.providerId,
          apiKey: cfg.apiKey,
          model: cfg.model,
          system,
          messages,
        });
      } catch (error: any) {
        const msg = `No se pudo contactar al modelo: ${error?.message ?? 'error'}`;
        session.history.push({ role: 'assistant', content: msg });
        events.push({ type: 'message', message: msg });
        return { events };
      }

      options.onRemote?.('Modelo remoto en línea.');

      // Sin tool calls → respuesta final de texto.
      if (!reply.toolCalls || reply.toolCalls.length === 0) {
        const text = reply.text ?? '(sin respuesta)';
        messages.push({ role: 'assistant', text, rawContent: reply.rawContent });
        session.history.push({ role: 'assistant', content: text });
        events.push({ type: 'message', message: text });
        return { events };
      }

      // Registrar el turno del asistente con sus tool calls (rawContent preserva
      // los bloques de thinking de Claude, que la API exige reenviar intactos).
      messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls, rawContent: reply.rawContent });
      if (reply.text) {
        session.history.push({ role: 'assistant', content: reply.text });
        events.push({ type: 'message', message: reply.text });
      }

      const resumed = await runToolBatch(session, messages, reply.toolCalls, 0, events);
      if (resumed === 'paused') return { events }; // esperando aprobación
    }

    const fallback = 'El agente alcanzó el máximo de pasos. Probá con un pedido más específico.';
    session.history.push({ role: 'assistant', content: fallback });
    events.push({ type: 'message', message: fallback });
    return { events };
  }

  /** Ejecuta un lote de tool calls desde `startIndex`. Devuelve 'paused' si una
   *  requiere aprobación (guardando el estado de reanudación), o 'done'. */
  async function runToolBatch(
    session: AgentSession,
    messages: AgentMessage[],
    batch: Array<{ id: string; name: string; args: Record<string, any> }>,
    startIndex: number,
    events: AgentRuntimeEvent[],
  ): Promise<'paused' | 'done'> {
    for (let i = startIndex; i < batch.length; i += 1) {
      const tc = batch[i];

      // El sub-agente se ejecuta acá adentro (necesita el modelo, no el executor).
      if (tc.name === 'subagent_run') {
        const task = String(tc.args.task ?? '').trim();
        const report = task
          ? await runSubagentTask(task)
          : '[subagent_run sin task: incluí la descripción completa de la subtarea.]';
        const result: ToolExecutionResult = {
          name: 'subagent.run',
          command: task.slice(0, 120) + (task.length > 120 ? '…' : ''),
          status: report.startsWith('[Sub-agente falló') ? 'error' : 'success',
          output: report,
          cwd: session.cwd,
        };
        messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, result: report });
        session.history.push({ role: 'system', content: toolResultToHistory(result) });
        events.push({ type: 'toolExecution', toolExecution: result });
        continue;
      }

      const call: ToolCallLike = { tool: dotName(tc.name), arguments: tc.args };
      const decision = classifyToolCall(call, {
        cwd: session.cwd,
        workspaceRoot: session.workspaceRoot,
      });

      if (decision.requiresApproval) {
        session.pendingApproval = { toolCall: call, summary: decision.summary, reason: decision.reason };
        (session as any).native = { messages, batch, nextIndex: i } as NativeResume;
        events.push({ type: 'approval', approval: session.pendingApproval });
        return 'paused';
      }

      const result = await executeAndRecord(session, messages, tc, call, events);
      if (result.cwd) session.cwd = result.cwd;
    }
    return 'done';
  }

  async function executeAndRecord(
    session: AgentSession,
    messages: AgentMessage[],
    tc: { id: string; name: string; args: Record<string, any> },
    call: ToolCallLike,
    events: AgentRuntimeEvent[],
  ): Promise<ToolExecutionResult> {
    let result: ToolExecutionResult;
    try {
      result = await options.executeToolCall(call, { cwd: session.cwd, workspaceRoot: session.workspaceRoot });
    } catch (error: any) {
      result = {
        name: call.tool,
        command: JSON.stringify(call.arguments),
        status: 'error',
        output: error?.message ?? 'La herramienta falló.',
        cwd: session.cwd,
      };
    }
    messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, result: result.output });
    session.history.push({ role: 'system', content: toolResultToHistory(result) });
    events.push({ type: 'toolExecution', toolExecution: result });
    return result;
  }

  async function runUserTurn(
    session: AgentSession,
    message: string,
    onEvent?: AgentEventSink,
  ): Promise<RuntimeResult> {
    session.history.push({ role: 'user', content: message });
    const messages = buildBaseMessages(session);
    return runLoop(session, messages, trackedEvents(onEvent));
  }

  async function resolveApproval(
    session: AgentSession,
    approved: boolean,
    onEvent?: AgentEventSink,
  ): Promise<RuntimeResult> {
    const pending = session.pendingApproval;
    const resume = (session as any).native as NativeResume | undefined;
    const events = trackedEvents(onEvent);
    if (!pending || !resume) {
      events.push({ type: 'message', message: 'No hay ninguna acción pendiente de aprobar.' });
      return { events };
    }
    session.pendingApproval = null;
    (session as any).native = undefined;
    const { messages, batch, nextIndex } = resume;
    const tc = batch[nextIndex];

    if (!approved) {
      // Rechazado: registramos el resultado y seguimos con el resto del lote.
      const rejected: ToolExecutionResult = {
        name: pending.toolCall.tool,
        command: JSON.stringify(pending.toolCall.arguments),
        status: 'error',
        output: 'El usuario rechazó esta acción.',
        cwd: session.cwd,
      };
      messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, result: rejected.output });
      session.history.push({ role: 'system', content: toolResultToHistory(rejected) });
      events.push({ type: 'toolExecution', toolExecution: rejected });
    } else {
      const call: ToolCallLike = { tool: pending.toolCall.tool, arguments: pending.toolCall.arguments };
      const result = await executeAndRecord(session, messages, tc, call, events);
      if (result.cwd) session.cwd = result.cwd;
    }

    // Continuar con el resto del lote y luego seguir el loop del modelo.
    const rest = await runToolBatch(session, messages, batch, nextIndex + 1, events);
    if (rest === 'paused') return { events };
    return runLoop(session, messages, events);
  }

  return { runUserTurn, resolveApproval };
}
