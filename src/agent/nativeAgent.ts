/**
 * Runtime del agente con function-calling NATIVO. Reemplaza al protocolo casero
 * de "un JSON por turno": ahora el modelo llama herramientas de verdad (como
 * Codex/Claude Code), lo que lo hace mucho más confiable y capaz de encadenar
 * pasos. Mantiene la misma interfaz de eventos y la sesión persistible.
 */
import { classifyToolCall } from './safety';
import { callModelWithTools, type AgentMessage } from './modelClient';
import { TOOL_NAME_TO_DOT, type ToolSchema } from './toolSchemas';
import { trackedEvents, compactHistoryIfNeeded, type AgentEventSink } from './runtime';
// SOLO el tipo: importar el valor McpManager (que usa node:child_process) rompería
// el bundle del navegador (vite). El check de tool MCP es una función local.
import type { McpToolDef } from './mcp';
import type { AgentSession, AgentRuntimeEvent } from './runtime';
import type { ToolCallLike, ToolExecutionResult } from './types';

/** ¿El nombre de tool pertenece a un servidor MCP? (mcp__servidor__tool) */
function isMcpToolName(name: string): boolean {
  return typeof name === 'string' && name.startsWith('mcp__');
}

export const NATIVE_SYSTEM_PROMPT = `You are NovaClaw, an autonomous software-engineering and phone assistant that runs ENTIRELY on the user's Android phone, inside an embedded Linux. You are the phone-native equivalent of Claude Code / Codex: same discipline, same rigor.

You have native tools. Call them to act — never describe what you would do, just do it silently, and explain everything ONCE at the end.

# How you communicate (CRITICAL — read carefully)

Work like Claude Code: reason internally, act with tools, and speak to the user ONLY ONCE, at the very end, with a single complete answer.

- While you are working (searching, reading, running commands, retrying), stay SILENT. Do NOT write chat messages between tool calls. NEVER emit narration like "Buscando…", "No encontré, sigo buscando", "Probemos otra cosa", "Veamos…", "Ahora voy a…". Those are wasted messages that cost the user tokens.
- Do ALL your thinking in your head (reasoning), not in the chat. Keep chaining tool calls — search wider, try variants, analyze — until the task is fully resolved.
- Only when you are completely DONE, send ONE final message with the full result. That single message is the only text the user should see from you in the whole turn.
- If you truly cannot finish without input from the user, that final message may ask a question — but only after you exhausted what you can do yourself.

# Final answer format

- Lead with the result/answer, not the process.
- ADAPT to what the user asked for. If they ask for detail, a breakdown, a comparison, or a table — give a rich, well-organized markdown answer: headings, **bold**, bullet lists, and GitHub-style tables (| col | col |). If they ask something simple, answer briefly. Match their request.
- When you present data you gathered (contacts, files, search results), format it cleanly (a table or a tidy list), never as a raw dump.

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
   - After editing a CODE file, call diagnostics on it to SEE real compiler/linter errors (types, syntax, lint). Fix whatever it reports, then check again until clean. This is how you catch mistakes instead of guessing.
   - Also run the code when it makes sense (terminal_run: node script.js, python x.py, npm test…) and read the output.
   - If it fails, read the error, fix it, and run again. Iterate until it works.
   - Never claim something works without having checked it with diagnostics or run it.
4. For big explorations or self-contained side tasks, delegate to subagent_run so this conversation stays focused. Give the sub-agent EVERY detail it needs (it knows nothing about this chat).
5. For any task with 3+ steps, call todo_write FIRST to lay out the plan, then update it (one step in_progress at a time, mark completed as you finish) so the user can follow along. Skip it for trivial one-step requests.

# Capabilities

- Shell (terminal_run): any command in the embedded Linux (397+ binaries). Install tools on request: pkg install X, npm install -g X, pip install X, git clone. With the Files connector on, the whole phone storage is at /sdcard (Download, DCIM photos, Documents…).
- Files: file_read (output has line numbers like \`cat -n\`; use offset+limit for big files), file_edit (surgical — do NOT include the line-number prefix in old_string), file_write, file_grep (content search), file_list, file_search (name search), workspace_mkdir.
- Vision (image_view): actually SEE an image file (a photo, a screenshot, a picture under /sdcard/DCIM or /sdcard/Pictures) — describe it, read text in it, analyze it. phone_photo takes a picture AND shows it to you automatically.
- Web (web_fetch): read documentation, APIs or any http(s) page as text. Use it when you need current information or library docs.
- Phone: phone_location (returns a human address — answer in plain language, e.g. "Estás en <street>, <city>, <country>", never raw coordinates), phone_contacts, phone_calendar (upcoming events for the next N days), phone_photo.
- Sub-agents (subagent_run): a fresh agent with clean context that reports back.
- MCP servers: you can INSTALL external tool servers yourself when the user asks ("instalá el MCP de GitHub"): use mcp_add (name, command='npx', args=['-y','<package>']). Use mcp_list to see what's connected and mcp_remove to remove one. Once added, its tools appear as mcp__<server>__<tool> and you can use them right away. If unsure of the exact npm package, web_fetch to find the official MCP server first.

# Project memory

- If a "Project memory" section appears below, it is persistent knowledge about this workspace (like CLAUDE.md). Respect it.
- When the user states a lasting preference, decision or fact worth remembering ("siempre usá X", "el proyecto se llama Y"), persist it: update the NOVACLAW.md file at the workspace root (file_edit if it exists, file_write if not). Keep it short and organized.

# Rules

- Be autonomous: chain as many tool calls as needed to FINISH the task before replying, all in silence. Do not stop halfway to ask "should I continue?".
- When several read-only lookups are needed (e.g. searching contacts by name AND by number), issue them together in the SAME turn so they run in parallel — don't spread them over many chatty turns.
- Reply in the user's language (Spanish by default for this user).
- Shell policy is allowlist-based: only recognized read-only/low-risk commands run directly; anything else (deletes, installs, unrecognized binaries, write redirections) triggers a user-approval dialog — that's expected, proceed with the call. Prefer the native tools (file_write, file_edit, workspace_mkdir) over shell equivalents for mutations: they don't need approval inside the workspace.
- Never invent file contents, command output, or API responses. If you didn't run it, say so.
- Remember: only your FINAL message is shown to the user. Make it count — complete, well-formatted (tables/detail when asked), leading with the result.`;

// El subagente: mismo poder, contexto limpio, sin aprobaciones ni sub-subagentes.
const SUBAGENT_SYSTEM_PROMPT = `You are a NovaClaw sub-agent running on the user's Android phone (embedded Linux). You receive ONE self-contained task and must complete it autonomously with your tools (terminal_run, file_read, file_edit, file_write, file_grep, file_list, file_search, workspace_mkdir, web_fetch, phone tools).

Rules:
- Explore with file_grep/file_read before editing; edit surgically with file_edit; verify by running code when applicable.
- You CANNOT perform approval-gated actions (deleting files, installing packages, writing outside the workspace). If the task needs one, note it in your report instead.
- Your FINAL message is your report to the main agent: make it complete, factual and concise. Include paths, line numbers and exact findings.`;

type RuntimeResult = { events: AgentRuntimeEvent[] };

// Tools de solo-lectura (nombres nativos, guion_bajo): no mutan estado ni cwd,
// así que varias seguidas en un turno se pueden ejecutar EN PARALELO.
const READ_ONLY_TOOLS = new Set([
  'file_read', 'file_grep', 'file_list', 'file_search',
  'web_fetch', 'phone_location', 'phone_contacts', 'image_view',
]);

type ConfigSnapshot = { providerId: string; apiKey: string; model: string };

// Traduce un fallo del modelo a un mensaje claro y accionable para el usuario:
// distingue falta de key / key inválida / sin internet, y siempre apunta a dónde
// resolverlo. Sin esto, un usuario nuevo veía "fetch failed" y no sabía qué hacer.
function friendlyModelError(error: any, apiKey: string): string {
  const raw = String(error?.message ?? error ?? '').toLowerCase();
  const settings = '\n\nAbrí **Ajustes → Modelo de IA** para configurarlo.';
  if (!apiKey?.trim()) {
    return 'Todavía no configuraste un modelo de IA (falta la API key).' + settings;
  }
  if (raw.includes('401') || raw.includes('403') || raw.includes('unauthorized') ||
      raw.includes('invalid') || raw.includes('api key') || raw.includes('forbidden')) {
    return 'Tu API key no es válida o venció, o el modelo elegido no está disponible con esa cuenta.' + settings;
  }
  if (raw.includes('fetch failed') || raw.includes('network') || raw.includes('enotfound') ||
      raw.includes('timeout') || raw.includes('etimedout') || raw.includes('econnrefused') ||
      raw.includes('getaddrinfo') || raw.includes('socket')) {
    return 'No pude conectarme con el modelo. Revisá tu conexión a internet e intentá de nuevo.';
  }
  return `No se pudo contactar al modelo: ${error?.message ?? 'error'}.` + settings;
}

interface NativeRuntimeOptions {
  workspaceRoot: string;
  getConfig: () => ConfigSnapshot;
  executeToolCall: (call: ToolCallLike, ctx: { cwd: string; workspaceRoot: string }) => Promise<ToolExecutionResult>;
  onRemote?: (label: string) => void;
  maxIterations?: number;
  /** Memoria persistente del proyecto (NOVACLAW.md) — se inyecta al system prompt. */
  getProjectContext?: () => Promise<string> | string;
  /** Inyección del cliente del modelo (tests / mocks). Por defecto callModelWithTools. */
  callModel?: typeof callModelWithTools;
  /** Tools de servidores MCP conectados (Fase 2) — se ofrecen al modelo como extra. */
  getMcpTools?: () => McpToolDef[];
  /** Ejecuta una tool MCP (mcp__servidor__tool). */
  callMcpTool?: (name: string, args: Record<string, any>) => Promise<string>;
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
      // Un resumen de compactación se presenta como contexto legible; el resto
      // (resultados de herramientas de turnos previos) como nota para el modelo.
      let note: string | null = null;
      try {
        const parsed = JSON.parse(entry.content);
        if (parsed && parsed.kind === 'history_summary' && parsed.summary) {
          note = `[Summary of earlier work in this session]\n${parsed.summary}`;
        } else if (parsed && parsed.kind === 'todo' && Array.isArray(parsed.todos)) {
          const lines = parsed.todos
            .map((t: any) => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`)
            .join('\n');
          note = `[Current task plan]\n${lines}`;
        }
      } catch {
        // no es JSON — se trata como resultado de herramienta
      }
      out.push({ role: 'user', text: note ?? `[tool result] ${entry.content}` });
    }
  }
  return out;
}

// Umbrales de compactación inteligente (resumen por el modelo).
const SUMMARIZE_THRESHOLD = 44; // si el historial supera esto, resumimos
const SUMMARIZE_KEEP_RECENT = 16; // últimas entradas que se dejan verbatim

// En modo PLAN, estas tools quedan bloqueadas (el agente solo lee/analiza).
const PLAN_BLOCKED_TOOLS = new Set(['file_write', 'file_edit', 'workspace_mkdir', 'terminal_run', 'subagent_run']);
function isPlanBlocked(name: string): boolean {
  return PLAN_BLOCKED_TOOLS.has(name) || isMcpToolName(name);
}

const PLAN_MODE_ADDENDUM = `

# PLAN MODE (ACTIVE)
You are in PLAN mode. Editing files, running commands, installing anything, sub-agents and MCP tools are BLOCKED. Only READ and analyze (file_read, file_grep, file_list, file_search, web_fetch, diagnostics, image_view). Investigate what's needed, then produce a clear, concrete step-by-step PLAN for the user to review — numbered steps, files to touch, commands to run. Do NOT try to apply it. The user will switch to Build mode to execute.`;

export function createNativeAgentRuntime(options: NativeRuntimeOptions) {
  const maxIterations = options.maxIterations ?? 32;
  const callModel = options.callModel ?? callModelWithTools;
  let turnMode: 'plan' | 'build' = 'build';

  function dotName(nativeName: string): string {
    return TOOL_NAME_TO_DOT[nativeName] ?? nativeName;
  }

  /** Tools de servidores MCP como ToolSchema, para ofrecerlas al modelo. */
  function mcpExtraTools(): ToolSchema[] {
    return (options.getMcpTools?.() ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: (t.inputSchema && typeof t.inputSchema === 'object'
        ? t.inputSchema
        : { type: 'object', properties: {} }) as ToolSchema['parameters'],
    }));
  }

  /**
   * Compactación INTELIGENTE: cuando el historial se hace largo, le pide al
   * modelo un resumen conciso de todo lo hecho hasta ahora y reemplaza las
   * entradas viejas por ese resumen (preservando el primer pedido del usuario
   * y las últimas N entradas verbatim). Es lo que hace Claude Code para no
   * perder el hilo en sesiones largas. Si el resumen falla, cae al recorte simple.
   */
  async function compactWithSummary(session: AgentSession): Promise<void> {
    if (session.history.length <= SUMMARIZE_THRESHOLD) return;

    const firstUser = session.history.find((e) => e.role === 'user');
    const recent = session.history.slice(-SUMMARIZE_KEEP_RECENT);
    const toSummarize = session.history.slice(
      firstUser ? 1 : 0,
      session.history.length - SUMMARIZE_KEEP_RECENT,
    );
    if (toSummarize.length === 0) return;

    const transcript = toSummarize
      .map((e) => `${e.role.toUpperCase()}: ${e.content}`)
      .join('\n')
      .slice(0, 24000);

    const cfg = options.getConfig();
    try {
      const reply = await callModel({
        providerId: cfg.providerId,
        apiKey: cfg.apiKey,
        model: cfg.model,
        system:
          'You compress an agent conversation. Produce a concise but COMPLETE summary that preserves: the user goals, decisions made, files created/edited (with paths), commands run and their key results, and anything still pending. Write it as durable notes the agent can rely on to continue. No preamble.',
        messages: [{ role: 'user', text: `Summarize this conversation so far:\n\n${transcript}` }],
        maxTokens: 1024,
      });
      const summary = (reply.text ?? '').trim();
      if (!summary) throw new Error('empty summary');

      const summaryEntry = {
        role: 'system' as const,
        content: JSON.stringify({
          kind: 'history_summary',
          note: '[Context compacted — summary of earlier work]',
          summary,
        }),
      };
      session.history = firstUser
        ? [firstUser, summaryEntry, ...recent]
        : [summaryEntry, ...recent];
    } catch {
      // Fallback: recorte simple (mismo criterio que el runtime legacy).
      session.history = compactHistoryIfNeeded(session.history);
    }
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
    if (turnMode === 'plan') system += PLAN_MODE_ADDENDUM;
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
        reply = await callModel({
          providerId: cfg.providerId,
          apiKey: cfg.apiKey,
          model: cfg.model,
          system: SUBAGENT_SYSTEM_PROMPT,
          messages,
          excludeTools: ['subagent_run', 'todo_write'],
          extraTools: mcpExtraTools(),
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
        let image: { mediaType: string; data: string } | undefined;
        if (decision.requiresApproval) {
          output = 'BLOCKED: this action needs user approval and sub-agents cannot request it. Report it back so the main agent can do it.';
        } else {
          try {
            const result = await options.executeToolCall(call, {
              cwd: options.workspaceRoot,
              workspaceRoot: options.workspaceRoot,
            });
            output = result.output;
            image = result.image;
          } catch (error: any) {
            output = error?.message ?? 'Tool failed.';
          }
        }
        messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, result: output });
        if (image) {
          messages.push({ role: 'user', text: `[image from ${call.tool}]`, images: [image] });
        }
      }
    }
    return '[El sub-agente alcanzó su límite de pasos sin terminar el reporte.]';
  }

  async function runLoop(
    session: AgentSession,
    messages: AgentMessage[],
    events: AgentRuntimeEvent[],
    signal?: AbortSignal,
  ): Promise<RuntimeResult> {
    const cfg = options.getConfig();
    const system = await buildSystemPrompt();

    for (let i = 0; i < maxIterations; i += 1) {
      // El usuario tocó Detener: cortamos limpio (el historial es texto plano,
      // así que el próximo turno se reconstruye sin restos colgantes).
      if (signal?.aborted) {
        session.history.push({ role: 'assistant', content: '⏹️ Respuesta detenida.' });
        events.push({ type: 'message', message: '⏹️ Respuesta detenida.' });
        return { events };
      }

      let reply;
      try {
        reply = await callModel({
          providerId: cfg.providerId,
          apiKey: cfg.apiKey,
          model: cfg.model,
          system,
          messages,
          abortSignal: signal,
          extraTools: mcpExtraTools(),
        });
      } catch (error: any) {
        if (signal?.aborted) {
          session.history.push({ role: 'assistant', content: '⏹️ Respuesta detenida.' });
          events.push({ type: 'message', message: '⏹️ Respuesta detenida.' });
          return { events };
        }
        const msg = friendlyModelError(error, cfg.apiKey);
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
      // IMPORTANTE: la narración intermedia (texto que acompaña a un tool call)
      // NO se muestra al usuario NI se guarda en el historial. El usuario recibe
      // UNA sola respuesta final (el turno sin tool calls, arriba). Así se evita
      // el spam de "Buscando…/No encontré…/Veamos…" y no se gastan tokens
      // reenviando esa cháchara en cada vuelta.
      messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls, rawContent: reply.rawContent });

      const resumed = await runToolBatch(session, messages, reply.toolCalls, 0, events, signal);
      if (resumed === 'paused') return { events }; // esperando aprobación
      if (resumed === 'aborted') {
        events.push({ type: 'message', message: '⏹️ Respuesta detenida.' });
        return { events };
      }
    }

    const fallback = 'El agente alcanzó el máximo de pasos. Probá con un pedido más específico.';
    session.history.push({ role: 'assistant', content: fallback });
    events.push({ type: 'message', message: fallback });
    return { events };
  }

  /** Ejecuta un lote de tool calls desde `startIndex`. Devuelve 'paused' si una
   *  requiere aprobación, 'aborted' si el usuario detuvo, o 'done'. */
  async function runToolBatch(
    session: AgentSession,
    messages: AgentMessage[],
    batch: Array<{ id: string; name: string; args: Record<string, any> }>,
    startIndex: number,
    events: AgentRuntimeEvent[],
    signal?: AbortSignal,
  ): Promise<'paused' | 'done' | 'aborted'> {
    let i = startIndex;
    while (i < batch.length) {
      if (signal?.aborted) return 'aborted';
      const tc = batch[i];

      // Modo PLAN: bloquear cualquier tool que mute o ejecute (solo lectura/análisis).
      if (turnMode === 'plan' && isPlanBlocked(tc.name)) {
        const blocked: ToolExecutionResult = {
          name: dotName(tc.name),
          command: JSON.stringify(tc.args ?? {}).slice(0, 120),
          status: 'error',
          output: 'PLAN MODE: editar archivos, ejecutar comandos, sub-agentes y MCP están bloqueados. Terminá el plan de pasos y el usuario lo aplica en modo Build.',
          cwd: session.cwd,
        };
        messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, result: blocked.output });
        session.history.push({ role: 'system', content: toolResultToHistory(blocked) });
        events.push({ type: 'toolExecution', toolExecution: blocked });
        i += 1;
        continue;
      }

      // Plan de tareas visible: no va al executor; emite un evento para la UI
      // y confirma al modelo. El agente lo usa para planear y trackear pasos.
      if (tc.name === 'todo_write') {
        const rawTodos = Array.isArray(tc.args.todos) ? tc.args.todos : [];
        const todos = rawTodos
          .map((t: any) => ({
            content: String(t?.content ?? '').trim(),
            status: ['pending', 'in_progress', 'completed'].includes(t?.status) ? t.status : 'pending',
          }))
          .filter((t: any) => t.content);
        const done = todos.filter((t: any) => t.status === 'completed').length;
        const summary = `Plan actualizado: ${done}/${todos.length} completadas.`;
        messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, result: summary });
        session.history.push({ role: 'system', content: JSON.stringify({ kind: 'todo', todos }) });
        events.push({ type: 'todo', todos });
        i += 1;
        continue;
      }

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
        i += 1;
        continue;
      }

      // Tool de un servidor MCP externo (mcp__servidor__tool): la ejecuta el manager.
      if (isMcpToolName(tc.name)) {
        let output: string;
        let status: 'success' | 'error' = 'success';
        try {
          output = options.callMcpTool
            ? await options.callMcpTool(tc.name, tc.args ?? {})
            : `MCP no disponible (${tc.name}).`;
          if (!options.callMcpTool || /^(MCP tool error|Herramienta MCP desconocida)/.test(output)) status = 'error';
        } catch (error: any) {
          output = error?.message ?? 'Error al llamar la tool MCP.';
          status = 'error';
        }
        const result: ToolExecutionResult = {
          name: tc.name,
          command: JSON.stringify(tc.args ?? {}).slice(0, 160),
          status,
          output,
          cwd: session.cwd,
        };
        messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, result: output });
        session.history.push({ role: 'system', content: toolResultToHistory(result) });
        events.push({ type: 'toolExecution', toolExecution: result });
        i += 1;
        continue;
      }

      // Corrida de tools de solo-lectura consecutivas → ejecutar EN PARALELO
      // (registramos los resultados en orden para mantener el hilo coherente).
      if (READ_ONLY_TOOLS.has(tc.name)) {
        let j = i;
        while (j < batch.length && READ_ONLY_TOOLS.has(batch[j].name)) j += 1;
        if (j - i > 1) {
          const group = batch.slice(i, j);
          const results = await Promise.all(
            group.map((g) => executeOnly(session, { tool: dotName(g.name), arguments: g.args })),
          );
          for (let k = 0; k < group.length; k += 1) {
            recordResult(session, messages, group[k], results[k], events);
          }
          i = j;
          continue;
        }
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
      i += 1;
    }
    return 'done';
  }

  /** Solo ejecuta la tool (sin registrar) — usado por la ejecución en paralelo. */
  async function executeOnly(session: AgentSession, call: ToolCallLike): Promise<ToolExecutionResult> {
    try {
      return await options.executeToolCall(call, { cwd: session.cwd, workspaceRoot: session.workspaceRoot });
    } catch (error: any) {
      return {
        name: call.tool,
        command: JSON.stringify(call.arguments),
        status: 'error',
        output: error?.message ?? 'La herramienta falló.',
        cwd: session.cwd,
      };
    }
  }

  /** Registra un resultado ya ejecutado: mensajes del modelo, imagen, historial, evento. */
  function recordResult(
    session: AgentSession,
    messages: AgentMessage[],
    tc: { id: string; name: string },
    result: ToolExecutionResult,
    events: AgentRuntimeEvent[],
  ): void {
    messages.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, result: result.output });
    // Visión: si la tool produjo una imagen (image.view / phone.photo), la
    // adjuntamos como mensaje de usuario para que el modelo la VEA de verdad.
    if (result.image) {
      messages.push({ role: 'user', text: `[image from ${result.name}]`, images: [result.image] });
    }
    session.history.push({ role: 'system', content: toolResultToHistory(result) });
    events.push({ type: 'toolExecution', toolExecution: result });
  }

  async function executeAndRecord(
    session: AgentSession,
    messages: AgentMessage[],
    tc: { id: string; name: string; args: Record<string, any> },
    call: ToolCallLike,
    events: AgentRuntimeEvent[],
  ): Promise<ToolExecutionResult> {
    const result = await executeOnly(session, call);
    recordResult(session, messages, tc, result, events);
    return result;
  }

  async function runUserTurn(
    session: AgentSession,
    message: string,
    onEvent?: AgentEventSink,
    signal?: AbortSignal,
    mode?: 'plan' | 'build',
  ): Promise<RuntimeResult> {
    turnMode = mode === 'plan' ? 'plan' : 'build';
    session.history.push({ role: 'user', content: message });
    // Conversaciones largas: resumir el historial con el modelo antes de armar
    // el contexto, para que el turno nunca reviente la ventana y no se pierda el hilo.
    await compactWithSummary(session);
    const messages = buildBaseMessages(session);
    return runLoop(session, messages, trackedEvents(onEvent), signal);
  }

  async function resolveApproval(
    session: AgentSession,
    approved: boolean,
    onEvent?: AgentEventSink,
    signal?: AbortSignal,
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
    const rest = await runToolBatch(session, messages, batch, nextIndex + 1, events, signal);
    if (rest === 'paused') return { events };
    if (rest === 'aborted') {
      events.push({ type: 'message', message: '⏹️ Respuesta detenida.' });
      return { events };
    }
    return runLoop(session, messages, events, signal);
  }

  return { runUserTurn, resolveApproval };
}
