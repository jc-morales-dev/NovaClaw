/**
 * mcpHttp.ts — Cliente MCP por HTTP (transporte "Streamable HTTP" del spec 2025).
 *
 * Permite conectar servidores MCP REMOTOS (una URL), no solo procesos locales
 * npx. Se hace POST de cada mensaje JSON-RPC al endpoint; la respuesta llega
 * como JSON o como stream SSE. Autenticación: cabeceras (típico
 * `Authorization: Bearer <token>`), con soporte de ${SECRET:<id>} igual que stdio.
 */
import type { McpToolDef } from './mcp';

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 30000;

/** Extrae el texto de un resultado tools/call (compartido con el cliente stdio). */
export function extractToolText(res: any): string {
  const content: any[] = Array.isArray(res?.content) ? res.content : [];
  const text = content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
  const body = text || JSON.stringify(res ?? {});
  return res?.isError ? `MCP tool error: ${body}` : body;
}

/** Busca en un stream SSE el mensaje JSON-RPC cuyo id coincide (o el primero con result/error). */
function parseSseForId(text: string, id: number | undefined): any {
  const events = text.split(/\n\n+/);
  let firstResult: any;
  for (const ev of events) {
    const data = ev
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    if (!data) continue;
    let msg: any;
    try { msg = JSON.parse(data); } catch { continue; }
    if (id !== undefined && msg?.id === id) return msg;
    if (firstResult === undefined && (msg?.result !== undefined || msg?.error !== undefined)) firstResult = msg;
  }
  return id === undefined ? undefined : firstResult;
}

export class McpHttpClient {
  tools: McpToolDef[] = [];
  private sessionId?: string;
  private nextId = 1;
  private lastErr = '';

  constructor(
    public readonly name: string,
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  lastStderr(): string {
    return this.lastErr;
  }

  private async rpc(method: string, params?: any, isNotification = false): Promise<any> {
    const id = isNotification ? undefined : this.nextId++;
    const payload: any = { jsonrpc: '2.0', method, ...(id !== undefined ? { id } : {}), ...(params ? { params } : {}) };
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
          ...this.headers,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e: any) {
      this.lastErr = e?.message ?? 'network error';
      throw new Error(this.lastErr);
    }
    const sid = res.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;
    if (isNotification) return null;
    if (!res.ok) {
      // 401 → el server pide autenticación (token en las cabeceras).
      const hint = res.status === 401 ? ' (falta autenticación: revisá el token en las cabeceras)' : '';
      this.lastErr = `HTTP ${res.status}${hint}: ${(await res.text().catch(() => '')).slice(0, 300)}`;
      throw new Error(this.lastErr);
    }
    const ct = res.headers.get('content-type') ?? '';
    let msg: any;
    if (ct.includes('text/event-stream')) {
      msg = parseSseForId(await res.text(), id);
    } else {
      const data = await res.json().catch(() => null);
      msg = Array.isArray(data) ? data.find((m) => m?.id === id) : data;
    }
    if (!msg) throw new Error('sin respuesta JSON-RPC del servidor MCP');
    if (msg.error) throw new Error(msg.error.message ?? 'error MCP');
    return msg.result;
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'NovaClaw', version: '1.0' },
    });
    await this.rpc('notifications/initialized', undefined, true);
    const res = await this.rpc('tools/list');
    const list: any[] = Array.isArray(res?.tools) ? res.tools : [];
    this.tools = list.map((t) => ({
      name: `mcp__${this.name}__${t.name}`,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      server: this.name,
      originalName: t.name,
    }));
  }

  async callTool(originalName: string, args: any): Promise<string> {
    const res = await this.rpc('tools/call', { name: originalName, arguments: args ?? {} });
    return extractToolText(res);
  }

  close(): void {
    // Streamable HTTP es sin estado del lado nuestro; nada que matar.
    this.tools = [];
  }
}
