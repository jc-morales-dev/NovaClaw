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
  const result = await mcpManager.connectAll(readMcpConfig());
  if (result.connected.length) console.log(`MCP conectado: ${result.connected.join(', ')}`);
  for (const f of result.failed) console.error(`MCP falló (${f.name}): ${f.error}`);
  return result;
}
