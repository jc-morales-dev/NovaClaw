import fs from 'node:fs';
import path from 'node:path';

import { createAgentRuntime } from '../agent/runtime';
import { createNativeAgentRuntime } from '../agent/nativeAgent';
import { createLocalToolExecutor, type FileChange } from '../agent/tools';
import { DEFAULT_CWD, zenConfig } from './config';
import { runtimeState } from './state';
import { mcpManager, readMcpConfig, reconnectMcp, writeMcpConfig } from './mcpRegistry';
import { callZenAgent } from './localFallback';
import { buildSkillsIndex } from './skills';

// Journal de cambios de archivo para "Deshacer" (los últimos N escritos/editados).
const changeJournal: FileChange[] = [];

export const sharedExecutor = createLocalToolExecutor({
  onFileChange: (c) => {
    changeJournal.push(c);
    if (changeJournal.length > 200) changeJournal.shift();
  },
  // Hotfix de seguridad: los hooks automáticos quedan desconectados hasta que
  // exista un flujo de confianza/aprobación por workspace. Un repo clonado puede
  // traer novaclaw.hooks.json ya creado; aprobar solo su escritura no protege ese
  // caso y cualquier file.write dispararía shell sin mostrar el comando.
  // Deja que el AGENTE instale/quite servidores MCP ("instalá el MCP de X").
  mcp: {
    list: () => ({
      configured: readMcpConfig() as Record<string, { command: string; args?: string[] }>,
      connected: mcpManager.listTools().map((t) => ({ name: t.name, server: t.server })),
    }),
    add: async (name, command, args, env) => {
      const cfg = readMcpConfig();
      cfg[name] = { command, args, ...(env ? { env } : {}) };
      writeMcpConfig(cfg);
      return reconnectMcp();
    },
    remove: async (name) => {
      const cfg = readMcpConfig();
      delete cfg[name];
      writeMcpConfig(cfg);
      return reconnectMcp();
    },
  },
});

export const localAgentRuntime = createAgentRuntime({
  workspaceRoot: DEFAULT_CWD,
  callModel: callZenAgent,
  executeToolCall: sharedExecutor,
  maxIterations: 18,
});

// Runtime PRO con function-calling nativo (cuando hay API key). Es el que hace
// que el agente se sienta como Codex/Claude Code: encadena herramientas reales.
export const nativeAgentRuntime = createNativeAgentRuntime({
  workspaceRoot: DEFAULT_CWD,
  getConfig: () => ({ providerId: zenConfig.provider, apiKey: zenConfig.apiKey, model: zenConfig.model }),
  executeToolCall: sharedExecutor,
  getMcpTools: () => mcpManager.listTools(),
  callMcpTool: (name, args) => mcpManager.call(name, args),
  onRemote: (label) => {
    runtimeState.agent.mode = 'remote';
    runtimeState.agent.label = label;
  },
  maxIterations: 32,
  // Memoria persistente del proyecto (como CLAUDE.md): el agente la lee en cada
  // turno y la actualiza él mismo cuando el usuario le enseña algo duradero.
  getProjectContext: () => {
    let ctx = '';
    try {
      const memoryPath = path.join(DEFAULT_CWD, 'NOVACLAW.md');
      if (fs.existsSync(memoryPath)) ctx = fs.readFileSync(memoryPath, 'utf8');
    } catch {
      // sin memoria de proyecto
    }
    // B6: índice de skills on-demand (skills/<nombre>/SKILL.md).
    const skills = buildSkillsIndex(DEFAULT_CWD);
    if (skills) ctx = ctx ? `${ctx}\n\n${skills}` : skills;
    return ctx;
  },
});

/** Elige el runtime: nativo si hay key, local heurístico si no. */
export function pickRuntime() {
  return zenConfig.apiKey ? nativeAgentRuntime : localAgentRuntime;
}

/** Revierte el último archivo que el agente escribió/editó (botón/comando Deshacer).
 *  Ambas ramas declaran todas las props (tsconfig sin strict: no hay narrowing). */
export type UndoResult = {
  ok: boolean;
  path?: string;
  remaining?: number;
  message?: string;
  status?: number;
};

export function undoLastChange(): UndoResult {
  const change = changeJournal.pop();
  if (!change) return { ok: false, message: 'No hay cambios para deshacer.' };
  try {
    if (change.existedBefore && change.before !== null) {
      fs.writeFileSync(change.path, change.before, 'utf8');
    } else {
      try { fs.unlinkSync(change.path); } catch { /* ya no existe */ }
    }
    return { ok: true, path: change.path, remaining: changeJournal.length };
  } catch (error: any) {
    return { ok: false, message: error?.message ?? 'No se pudo deshacer.', status: 500 };
  }
}
