/**
 * Runtime del agente con function-calling NATIVO. Reemplaza al protocolo casero
 * de "un JSON por turno": ahora el modelo llama herramientas de verdad (como
 * Codex/Claude Code), lo que lo hace mucho más confiable y capaz de encadenar
 * pasos. Mantiene la misma interfaz de eventos y la sesión persistible.
 *
 * Los prompts largos viven en ./nativePrompts y los helpers puros / tipos en
 * ./nativeAgentSupport; acá queda solo la orquestación del loop.
 */
import { classifyToolCall } from './safety';
import { callModelWithTools, type AgentMessage, type AgentImage } from './modelClient';
import { TOOL_NAME_TO_DOT, type ToolSchema } from './toolSchemas';
import { trackedEvents, compactHistoryIfNeeded, type AgentEventSink } from './runtime';
import type { AgentSession, AgentRuntimeEvent } from './runtime';
import type { ToolCallLike, ToolExecutionResult } from './types';
import { NATIVE_SYSTEM_PROMPT, SUBAGENT_SYSTEM_PROMPT, PLAN_MODE_ADDENDUM } from './nativePrompts';
import {
  isMcpToolName,
  isCodeFile,
  isPlanBlocked,
  estimateHistoryTokens,
  friendlyModelError,
  toolResultToHistory,
  buildBaseMessages,
  READ_ONLY_TOOLS,
  VERIFY_CMD,
  SUMMARIZE_THRESHOLD,
  SUMMARIZE_KEEP_RECENT,
  TOKEN_COMPACT_THRESHOLD,
  type NativeRuntimeOptions,
  type NativeResume,
  type RuntimeResult,
} from './nativeAgentSupport';

// Re-export para no cambiar la superficie pública del módulo.
export { NATIVE_SYSTEM_PROMPT };

export function createNativeAgentRuntime(options: NativeRuntimeOptions) {
  const maxIterations = options.maxIterations ?? 32;
  const callModel = options.callModel ?? callModelWithTools;
  let turnMode: 'plan' | 'build' | 'auto' = 'build';

  function dotName(nativeName: string): string {
    return TOOL_NAME_TO_DOT[nativeName] ?? nativeName;
  }

  // ── Guardrails del harness: le sacan más jugo a CUALQUIER modelo (sobre todo
  // los chicos/gratis, que se traban repitiendo una tool, alucinan nombres de
  // tools o se rinden). Son a nivel harness → andan con cualquier modelo y no
  // estorban a los fuertes (rara vez los disparan).
  const KNOWN_TOOLS = new Set(Object.keys(TOOL_NAME_TO_DOT));
  // Cuenta llamadas idénticas (name+args) dentro del turno para cortar loops.
  let loopGuard = new Map<string, number>();
  // Verificación obligatoria (B3): pendingVerify se prende al editar código y se
  // apaga al correr diagnostics o ejecutar/testear. Si el modelo intenta cerrar
  // con código sin verificar, lo empujamos UNA vez a verificar antes de responder.
  let pendingVerify = false;
  let verifyNudged = false;

  /** Aviso si esta MISMA llamada ya se repitió demasiado en el turno (loop). */
  function loopWarning(tc: { name: string; args: Record<string, any> }): string | null {
    if (tc.name === 'todo_write') return null; // sus args cambian legítimamente
    const fp = tc.name + '::' + JSON.stringify(tc.args ?? {});
    const n = (loopGuard.get(fp) ?? 0) + 1;
    loopGuard.set(fp, n);
    if (n >= 3) {
      return `Ya ejecutaste esta MISMA llamada (${dotName(tc.name)}) ${n} veces con argumentos idénticos; el resultado no va a cambiar. NO la repitas. Usá lo que ya obtuviste, cambiá de estrategia (otros argumentos u otra herramienta), o si ya tenés lo necesario dá la respuesta final AHORA.`;
    }
    return null;
  }

  /** Si el modelo alucina un nombre de tool inexistente, lo guiamos a las válidas. */
  function unknownToolHint(name: string): string | null {
    if (KNOWN_TOOLS.has(name) || isMcpToolName(name)) return null;
    return `La herramienta "${name}" no existe. Usá una de estas: ${[...KNOWN_TOOLS].join(', ')}. Reintentá con el nombre exacto.`;
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
    if (session.history.length <= SUMMARIZE_THRESHOLD
      && estimateHistoryTokens(session.history) < TOKEN_COMPACT_THRESHOLD) return;

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
      .slice(0, 32000);

    const cfg = options.getConfig();
    try {
      const reply = await callModel({
        providerId: cfg.providerId,
        apiKey: cfg.apiKey,
        model: cfg.model,
        system:
          'You compress a coding-agent conversation into durable notes the agent will rely on to CONTINUE the task. Preserve, explicitly and structured: (1) the user goal(s); (2) files created/edited with their FULL paths and what changed in each; (3) commands run and their KEY results (errors, test/diagnostics output); (4) decisions and constraints; (5) the current task plan / TODO state; (6) anything still pending or unresolved. Keep exact identifiers (paths, names, flags). Do NOT invent anything not present. No preamble — just the notes.',
        messages: [{ role: 'user', text: `Summarize this conversation so far:\n\n${transcript}` }],
        maxTokens: 2048,
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
        system += `\n\n# Project context (NOVACLAW.md + skills)\n${ctx.trim().slice(0, 12000)}`;
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

      // Aviso de presupuesto: cuando quedan pocos pasos, empujamos al modelo a
      // CERRAR (dar la respuesta) en vez de chocar contra el tope y perder el
      // turno entero sin devolverle nada al usuario. Ayuda mucho a modelos que
      // se dispersan. Se inyecta una sola vez.
      const stepsLeft = maxIterations - i;
      if (stepsLeft === 6) {
        messages.push({
          role: 'user',
          text: '[sistema] Te quedan pocos pasos en este turno. Si ya tenés con qué responder, dá la respuesta final AHORA; si no, andá directo a lo esencial y cerrá.',
        });
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
          // B10: streaming en vivo (solo camino OpenAI). Cada fragmento se emite
          // como messageDelta; la UI lo escribe y el 'message' final lo cierra.
          onTextDelta: (delta) => { events.push({ type: 'messageDelta', delta }); },
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
        // B3: si editó código y no lo verificó, empujarlo UNA vez a verificar
        // antes de dejarlo cerrar (así no dice "listo" sin haber comprobado).
        if (pendingVerify && !verifyNudged && turnMode === 'build') {
          verifyNudged = true;
          messages.push({
            role: 'user',
            text: '[sistema] Editaste código en este turno pero todavía no lo verificaste. Antes de responder, corré `diagnostics` sobre el/los archivo(s) que tocaste (y si aplica, ejecutá el código o los tests con terminal_run) y arreglá lo que reporte. Si ya está todo verificado, respondé normalmente.',
          });
          continue;
        }
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

    const fallback = 'Llegué al límite de pasos de este turno sin cerrar del todo la tarea. Contame si querés que siga, o acotá un poco el pedido para terminarlo.';
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

      // Guardrail: nombre de tool alucinado → guiar al modelo a las válidas en
      // vez de fallar con un error críptico (los modelos chicos inventan tools).
      const unknownHint = unknownToolHint(tc.name);
      if (unknownHint) {
        const warn: ToolExecutionResult = {
          name: tc.name,
          command: JSON.stringify(tc.args ?? {}).slice(0, 120),
          status: 'error',
          output: unknownHint,
          cwd: session.cwd,
        };
        recordResult(session, messages, tc, warn, events);
        i += 1;
        continue;
      }

      // Guardrail anti-loop: si el modelo repite la MISMA llamada una y otra vez
      // (típico de modelos débiles trabados), la cortamos con un aviso claro en
      // vez de re-ejecutarla al pedo y consumir el turno.
      const loopMsg = loopWarning(tc);
      if (loopMsg) {
        const warn: ToolExecutionResult = {
          name: dotName(tc.name),
          command: JSON.stringify(tc.args ?? {}).slice(0, 120),
          status: 'error',
          output: loopMsg,
          cwd: session.cwd,
        };
        recordResult(session, messages, tc, warn, events);
        i += 1;
        continue;
      }

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
      // B8: varios subagent_run seguidos → EN PARALELO (fan-out de exploración,
      // como Claude Code cuando reparte lecturas/búsquedas independientes).
      if (tc.name === 'subagent_run') {
        let j = i;
        while (j < batch.length && batch[j].name === 'subagent_run') j += 1;
        const group = batch.slice(i, j);
        const reports = await Promise.all(group.map((g) => {
          const t = String(g.args.task ?? '').trim();
          return t
            ? runSubagentTask(t)
            : Promise.resolve('[subagent_run sin task: incluí la descripción completa de la subtarea.]');
        }));
        for (let k = 0; k < group.length; k += 1) {
          const g = group[k];
          const report = reports[k];
          const t = String(g.args.task ?? '').trim();
          const result: ToolExecutionResult = {
            name: 'subagent.run',
            command: t.slice(0, 120) + (t.length > 120 ? '…' : ''),
            status: report.startsWith('[Sub-agente falló') ? 'error' : 'success',
            output: report,
            cwd: session.cwd,
          };
          messages.push({ role: 'tool', toolCallId: g.id, toolName: g.name, result: report });
          session.history.push({ role: 'system', content: toolResultToHistory(result) });
          events.push({ type: 'toolExecution', toolExecution: result });
        }
        i = j;
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

      // Auto = omitir permisos; o si el usuario ya aprobó "siempre" esta tool.
      const needsApproval = decision.requiresApproval
        && turnMode !== 'auto'
        && !(session.autoApproveTools ?? []).includes(call.tool);
      if (needsApproval) {
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
    // B3: rastrear si quedó código editado sin verificar en este turno.
    if ((tc.name === 'file_write' || tc.name === 'file_edit' || tc.name === 'file_edit_multi')
      && result.status === 'success' && isCodeFile(result.command)) {
      pendingVerify = true;
    } else if (tc.name === 'diagnostics') {
      pendingVerify = false;
    } else if (tc.name === 'terminal_run' && VERIFY_CMD.test(String(result.command ?? ''))) {
      pendingVerify = false;
    }
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
    mode?: 'plan' | 'build' | 'auto',
    images?: AgentImage[],
  ): Promise<RuntimeResult> {
    turnMode = mode === 'plan' ? 'plan' : mode === 'auto' ? 'auto' : 'build';
    loopGuard = new Map(); // el anti-loop se cuenta por turno
    pendingVerify = false; // la verificación obligatoria también es por turno
    verifyNudged = false;
    session.history.push({ role: 'user', content: message });
    // Conversaciones largas: resumir el historial con el modelo antes de armar
    // el contexto, para que el turno nunca reviente la ventana y no se pierda el hilo.
    await compactWithSummary(session);
    const messages = buildBaseMessages(session);
    // Imagen adjunta por el usuario: se cuelga del mensaje de usuario del turno
    // para que el modelo la VEA (no se persiste en el historial, que es texto).
    if (images?.length) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === 'user') { messages[i].images = images; break; }
      }
    }
    return runLoop(session, messages, trackedEvents(onEvent), signal);
  }

  async function resolveApproval(
    session: AgentSession,
    approved: boolean,
    onEvent?: AgentEventSink,
    signal?: AbortSignal,
    scope?: 'once' | 'always',
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

    // "Siempre en este chat": recordamos la tool para no volver a preguntar.
    if (approved && scope === 'always') {
      session.autoApproveTools = session.autoApproveTools ?? [];
      if (!session.autoApproveTools.includes(pending.toolCall.tool)) {
        session.autoApproveTools.push(pending.toolCall.tool);
      }
    }
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
