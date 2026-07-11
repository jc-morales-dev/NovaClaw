import fs from 'node:fs';
import path from 'node:path';

import { McpManager, type McpServerConfig } from '../agent/mcp';
import { NOVACLAW_CONFIG_PATH } from './config';

// ── Servidores MCP (Fase 2): herramientas externas para el agente ──────────────
// Config en novaclaw.mcp.json (junto al config): { "mcpServers": { "nombre":
// { "command": "npx", "args": ["-y", "@algo/mcp-server"], "env": {...} } } }.
export const MCP_CONFIG_PATH = process.env.NOVACLAW_MCP_CONFIG
  || path.join(path.dirname(NOVACLAW_CONFIG_PATH), 'novaclaw.mcp.json');

export const mcpManager = new McpManager();

// ── Secretos de MCP (tokens) ────────────────────────────────────────────────
// En Android viven CIFRADOS en el Keystore; el agente (Node) los pide al server
// nativo por loopback (token-gated), igual que las tools del teléfono. En dev
// (PC) caen a la env var MCP_SECRET_<ID> o a novaclaw.secrets.json (gitignored).
// El archivo de config NUNCA guarda el token: solo el placeholder ${SECRET:<id>}.
const NATIVE_BASE = process.env.NOVACLAW_NATIVE_URL || 'http://127.0.0.1:8099';
const SECRETS_FILE = path.join(path.dirname(NOVACLAW_CONFIG_PATH), 'novaclaw.secrets.json');

export async function resolveMcpSecret(id: string): Promise<string | null> {
  // 1) Servidor nativo (teléfono): Keystore cifrado.
  if (process.env.NOVACLAW_TOKEN || process.env.NOVACLAW_NATIVE_URL) {
    try {
      const res = await fetch(`${NATIVE_BASE}/secret?ref=${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(8000),
        headers: process.env.NOVACLAW_TOKEN ? { 'X-Nova-Token': process.env.NOVACLAW_TOKEN } : undefined,
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data?.value === 'string' && data.value) return data.value;
      }
    } catch { /* cae al fallback de dev */ }
  }
  // 2) Dev (PC): env var.
  const envKey = `MCP_SECRET_${id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
  if (process.env[envKey]) return process.env[envKey] as string;
  // 3) Dev (PC): archivo local gitignored.
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      const map = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
      if (typeof map?.[id] === 'string' && map[id]) return map[id];
    }
  } catch { /* ignore */ }
  return null;
}

/** Guarda un secreto en dev (PC). En el teléfono lo guarda el bridge nativo. */
export function saveMcpSecretDev(id: string, value: string): void {
  let map: Record<string, string> = {};
  try { if (fs.existsSync(SECRETS_FILE)) map = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')); } catch { map = {}; }
  if (value) map[id] = value; else delete map[id];
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(map, null, 2), 'utf8');
}

export function readMcpConfig(): Record<string, McpServerConfig> {
  try {
    if (!fs.existsSync(MCP_CONFIG_PATH)) return {};
    const raw = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf8'));
    return (raw?.mcpServers ?? raw ?? {}) as Record<string, McpServerConfig>;
  } catch (error: any) {
    console.error('novaclaw.mcp.json inválido:', error?.message);
    return {};
  }
}

export function writeMcpConfig(servers: Record<string, McpServerConfig>): void {
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');
}

/** (Re)conecta todos los servidores MCP del config. Devuelve el resultado. */
export async function reconnectMcp(): Promise<{ connected: string[]; failed: Array<{ name: string; error: string }> }> {
  mcpManager.closeAll();
  const result = await mcpManager.connectAll(readMcpConfig(), resolveMcpSecret);
  if (result.connected.length) console.log(`MCP conectado: ${result.connected.join(', ')}`);
  for (const f of result.failed) console.error(`MCP falló (${f.name}): ${f.error}`);
  return result;
}
