/**
 * nativeAgentSupport.ts — Helpers PUROS, constantes y tipos del runtime nativo
 * (nativeAgent.ts). Nada acá cierra sobre el estado del runtime: son funciones
 * sin efectos + tablas de configuración, separadas para dejar el loop del agente
 * enfocado en la orquestación. Solo imports de TIPO / lógica → browser-safe.
 */
import { callModelWithTools, type AgentMessage, type ModelEffort } from './modelClient';
import type { McpToolDef } from './mcp';
import type { AgentSession, AgentRuntimeEvent } from './runtime';
import type { ToolCallLike, ToolExecutionResult } from './types';

/** ¿El nombre de tool pertenece a un servidor MCP? (mcp__servidor__tool) */
export function isMcpToolName(name: string): boolean {
  return typeof name === 'string' && name.startsWith('mcp__');
}

// Tools de solo-lectura (nombres nativos, guion_bajo): no mutan estado ni cwd,
// así que varias seguidas en un turno se pueden ejecutar EN PARALELO.
// Tools que se pueden correr EN PARALELO sin pasar por la política de aprobación.
// Ojo al agregar acá: este camino usa executeOnly, que NO consulta
// classifyToolCall — una tool con aprobación obligatoria metida en esta lista se
// ejecutaría igual. Por eso salieron file_extract y code_intel: ejecutan código
// del proyecto (config de linter, language server) y ahora exigen aprobación.
export const READ_ONLY_TOOLS = new Set([
  'file_read', 'file_grep', 'file_list', 'file_search',
  'deep_research', 'web_search', 'web_fetch', 'phone_location', 'phone_contacts', 'image_view',
]);

// Verificación obligatoria (B3): tras editar un archivo de CÓDIGO, el harness
// empuja a correr diagnostics/ejecutar antes de dar la respuesta final.
const CODE_FILE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.kt', '.kts', '.json', '.c', '.cc', '.cpp', '.h', '.hpp', '.rb', '.php',
  '.swift', '.vue', '.svelte', '.sh',
]);
export function isCodeFile(p: string): boolean {
  const i = String(p).lastIndexOf('.');
  return i >= 0 && CODE_FILE_EXTS.has(String(p).slice(i).toLowerCase());
}
// Comandos que cuentan como "verificar" (compilar/testear/ejecutar).
export const VERIFY_CMD = /\b(tsc|node|python3?|npm|pnpm|yarn|deno|bun|go|cargo|pytest|ruff|eslint|jest|vitest|mocha|make|test|build|--check|--noEmit)\b/i;

// En modo PLAN, estas tools quedan bloqueadas (el agente solo lee/analiza).
// mcp_add/mcp_remove entran acá porque instalar un servidor MCP arranca un
// proceso (npx descarga y ejecuta): eso no es "planificar", es actuar.
const PLAN_BLOCKED_TOOLS = new Set([
  'file_write', 'file_edit', 'file_edit_multi', 'workspace_mkdir', 'terminal_run', 'subagent_run',
  'mcp_add', 'mcp_remove', 'diagnostics_check', 'code_intel', 'file_extract',
]);
export function isPlanBlocked(name: string): boolean {
  // El runtime nativo usa file_write y el legacy file.write.
  const normalized = String(name).replaceAll('.', '_');
  return PLAN_BLOCKED_TOOLS.has(normalized) || isMcpToolName(name);
}

// Umbrales de compactación inteligente (resumen por el modelo).
export const SUMMARIZE_THRESHOLD = 44; // si el historial supera esto, resumimos
export const SUMMARIZE_KEEP_RECENT = 16; // últimas entradas que se dejan verbatim
// B9: además del conteo de entradas, compactar cuando el contexto estimado en
// tokens (≈ chars/4) se acerca a la ventana, para no reventarla con pocos
// mensajes pero enormes (lecturas grandes, salidas largas de terminal).
export const TOKEN_COMPACT_THRESHOLD = 100_000;
export function estimateHistoryTokens(history: { content: string }[]): number {
  let chars = 0;
  for (const e of history) chars += e.content?.length ?? 0;
  return Math.ceil(chars / 4);
}

export type RuntimeResult = { events: AgentRuntimeEvent[] };

export type ConfigSnapshot = { providerId: string; apiKey: string; model: string; effort?: ModelEffort };

export interface NativeRuntimeOptions {
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
export interface NativeResume {
  messages: AgentMessage[];
  batch: Array<{ id: string; name: string; args: Record<string, any> }>;
  nextIndex: number;
  mode: 'plan' | 'build' | 'auto';
}

export function toolResultToHistory(result: ToolExecutionResult): string {
  return JSON.stringify({
    tool: result.name,
    command: result.command,
    status: result.status,
    output: result.output,
    cwd: result.cwd,
  });
}

// Traduce un fallo del modelo a un mensaje claro y accionable para el usuario:
// distingue falta de key / key inválida / sin internet, y siempre apunta a dónde
// resolverlo. Sin esto, un usuario nuevo veía "fetch failed" y no sabía qué hacer.
export function friendlyModelError(error: any, apiKey: string): string {
  const raw = String(error?.message ?? error ?? '').toLowerCase();
  const settings = '\n\nAbrí **Ajustes → Modelo de IA** para configurarlo.';
  if (!apiKey?.trim()) {
    return 'Todavía no configuraste un modelo de IA (falta la API key).' + settings;
  }
  // 429 va PRIMERO: es el error más común en los niveles gratuitos (NVIDIA,
  // OpenRouter free) y antes caía en el mensaje genérico o —peor— en el de red,
  // que mandaba al usuario a revisar el wifi cuando el wifi andaba perfecto.
  if (raw.includes('429') || raw.includes('too many requests') || raw.includes('rate limit')) {
    return 'Alcanzaste el límite de uso del proveedor (error 429). No es tu conexión: es la cuota. Esperá unos minutos, o cambiá de modelo o de proveedor.' + settings;
  }
  // Sobrecarga temporal del proveedor: tampoco es culpa del usuario ni de su red.
  if (raw.includes('503') || raw.includes('529') || raw.includes('overloaded') || raw.includes('unavailable')) {
    return 'El proveedor está sobrecargado en este momento. Probá de nuevo en un rato, o cambiá de modelo en Ajustes.';
  }
  if (raw.includes('401') || raw.includes('403') || raw.includes('unauthorized') ||
      raw.includes('api key') || raw.includes('forbidden')) {
    return 'Tu API key no es válida o venció, o el modelo elegido no está disponible con esa cuenta.' + settings;
  }
  if (raw.includes('fetch failed') || raw.includes('network') || raw.includes('enotfound') ||
      raw.includes('etimedout') || raw.includes('econnrefused') ||
      raw.includes('getaddrinfo') || raw.includes('socket')) {
    return 'No pude conectarme con el modelo. Revisá tu conexión a internet e intentá de nuevo.';
  }
  return `No se pudo contactar al modelo: ${error?.message ?? 'error'}.` + settings;
}

/** Reconstruye el contexto de mensajes para el modelo a partir del historial
 *  visible de la sesión (turnos previos como texto). */
export function buildBaseMessages(session: AgentSession): AgentMessage[] {
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
