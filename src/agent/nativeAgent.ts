/**
 * Runtime del agente con function-calling NATIVO. Reemplaza al protocolo casero
 * de "un JSON por turno": ahora el modelo llama herramientas de verdad (como
 * Codex/Claude Code), lo que lo hace mucho más confiable y capaz de encadenar
 * pasos. Mantiene la misma interfaz de eventos y la sesión persistible.
 */
import { classifyToolCall } from './safety';
import { callModelWithTools, type AgentMessage } from './modelClient';
import { TOOL_NAME_TO_DOT } from './toolSchemas';
import type { AgentSession, AgentRuntimeEvent } from './runtime';
import type { ToolCallLike, ToolExecutionResult } from './types';

export const NATIVE_SYSTEM_PROMPT = `You are NovaClaw, an autonomous coding and phone assistant that runs entirely on the user's Android phone, inside an embedded Linux.

You have native tools. Call them to act — do not describe what you would do, just do it, then explain the result.

Capabilities:
- Shell (terminal_run): run any command in the embedded Linux. Install tools on request with pkg/npm/pip or "git clone". With the Files connector on, the whole phone storage is at /sdcard (Download, DCIM photos, Documents…) — you can find, read and (after confirming) delete files there.
- Files: file_read, file_write, file_list, file_search, workspace_mkdir.
- Phone: phone_location (returns a human address — answer in plain language, e.g. "Estás en <street>, <city>, <country>", not raw coordinates), phone_contacts, phone_photo.

Rules:
- Be autonomous: chain multiple tool calls to finish the task before replying.
- Reply in the user's language (Spanish by default for this user).
- Before a destructive or sensitive action (deleting/overwriting files, installing packages), the runtime will ask the user to approve — that's expected.
- When done, give a concise, useful answer. Use markdown.`;

type RuntimeResult = { events: AgentRuntimeEvent[] };

type ConfigSnapshot = { providerId: string; apiKey: string; model: string };

interface NativeRuntimeOptions {
  workspaceRoot: string;
  getConfig: () => ConfigSnapshot;
  executeToolCall: (call: ToolCallLike, ctx: { cwd: string; workspaceRoot: string }) => Promise<ToolExecutionResult>;
  onRemote?: (label: string) => void;
  maxIterations?: number;
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
  const maxIterations = options.maxIterations ?? 18;

  function dotName(nativeName: string): string {
    return TOOL_NAME_TO_DOT[nativeName] ?? nativeName;
  }

  async function runLoop(
    session: AgentSession,
    messages: AgentMessage[],
    events: AgentRuntimeEvent[],
  ): Promise<RuntimeResult> {
    const cfg = options.getConfig();

    for (let i = 0; i < maxIterations; i += 1) {
      let reply;
      try {
        reply = await callModelWithTools({
          providerId: cfg.providerId,
          apiKey: cfg.apiKey,
          model: cfg.model,
          system: NATIVE_SYSTEM_PROMPT,
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
        messages.push({ role: 'assistant', text });
        session.history.push({ role: 'assistant', content: text });
        events.push({ type: 'message', message: text });
        return { events };
      }

      // Registrar el turno del asistente con sus tool calls.
      messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls });
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

  async function runUserTurn(session: AgentSession, message: string): Promise<RuntimeResult> {
    session.history.push({ role: 'user', content: message });
    const messages = buildBaseMessages(session);
    return runLoop(session, messages, []);
  }

  async function resolveApproval(session: AgentSession, approved: boolean): Promise<RuntimeResult> {
    const pending = session.pendingApproval;
    const resume = (session as any).native as NativeResume | undefined;
    if (!pending || !resume) {
      return { events: [{ type: 'message', message: 'No hay ninguna acción pendiente de aprobar.' }] };
    }
    session.pendingApproval = null;
    (session as any).native = undefined;

    const events: AgentRuntimeEvent[] = [];
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
