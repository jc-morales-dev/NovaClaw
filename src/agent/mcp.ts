/**
 * Cliente MCP (Model Context Protocol) — Fase 2 hacia nivel OpenCode.
 *
 * Permite conectar "servidores MCP" externos (npx -y @algo/mcp-server, o cualquier
 * comando) y exponer SUS herramientas al agente como tools extra. Es el mismo
 * protocolo que usan Claude Desktop / Cursor / OpenCode.
 *
 * Transporte: stdio con JSON-RPC 2.0 delimitado por saltos de línea (una línea =
 * un mensaje), que es el transporte estándar de MCP para procesos locales.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Tool descubierta en un servidor MCP, ya con nombre namespaced para el modelo. */
export interface McpToolDef {
  /** Nombre expuesto al modelo: mcp__<servidor>__<tool>. */
  name: string;
  description: string;
  /** JSON Schema de los parámetros. */
  inputSchema: any;
  server: string;
  originalName: string;
}

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 30000;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private dead = false;
  tools: McpToolDef[] = [];

  constructor(
    public readonly name: string,
    command: string,
    args: string[],
    env?: Record<string, string>,
  ) {
    // Sin shell: execvp resuelve el comando por PATH (que en el teléfono incluye
    // $PREFIX/bin, donde está npx). Evita problemas de quoting y es más seguro.
    this.child = spawn(command, args, {
      env: { ...process.env, ...(env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (d: Buffer) => this.onData(d));
    this.child.stderr.on('data', () => { /* logs del servidor: ignorar */ });
    this.child.on('error', (e) => this.die(`no se pudo iniciar: ${e.message}`));
    this.child.on('exit', (code) => this.die(`el servidor MCP terminó (código ${code ?? '?'})`));
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'error MCP'));
        else p.resolve(msg.result);
      }
      // Notificaciones del servidor (sin id): se ignoran en esta versión.
    }
  }

  private die(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }

  private request(method: string, params?: any): Promise<any> {
    if (this.dead) return Promise.reject(new Error('servidor MCP no disponible'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout en ${method}`)); }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (e: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(e?.message ?? 'fallo al escribir al servidor MCP'));
      }
    });
  }

  private notify(method: string, params?: any): void {
    try { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); } catch { /* ignore */ }
  }

  /** Handshake + descubrimiento de tools. */
  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'NovaClaw', version: '1.0' },
    });
    this.notify('notifications/initialized');
    const res = await this.request('tools/list');
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
    const res = await this.request('tools/call', { name: originalName, arguments: args ?? {} });
    const content: any[] = Array.isArray(res?.content) ? res.content : [];
    const text = content
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    const body = text || JSON.stringify(res ?? {});
    return res?.isError ? `MCP tool error: ${body}` : body;
  }

  close(): void {
    this.die('cerrado');
    try { this.child.kill(); } catch { /* ignore */ }
  }
}

/** Administra varios servidores MCP y enruta las llamadas a tools. */
export class McpManager {
  private clients: McpClient[] = [];

  /** Conecta todos los servidores del config. Los que fallan no rompen al resto. */
  async connectAll(
    servers: Record<string, McpServerConfig> | undefined,
  ): Promise<{ connected: string[]; failed: Array<{ name: string; error: string }> }> {
    const connected: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const [name, cfg] of Object.entries(servers ?? {})) {
      if (!cfg?.command) { failed.push({ name, error: 'falta "command"' }); continue; }
      const client = new McpClient(name, cfg.command, cfg.args ?? [], cfg.env);
      try {
        await client.initialize();
        this.clients.push(client);
        connected.push(name);
      } catch (error: any) {
        client.close();
        failed.push({ name, error: error?.message ?? 'fallo al conectar' });
      }
    }
    return { connected, failed };
  }

  /** Todas las tools descubiertas (con nombre mcp__servidor__tool). */
  listTools(): McpToolDef[] {
    return this.clients.flatMap((c) => c.tools);
  }

  /** ¿Este nombre de tool pertenece a un servidor MCP? */
  static isMcpTool(name: string): boolean {
    return typeof name === 'string' && name.startsWith('mcp__');
  }

  async call(prefixedName: string, args: any): Promise<string> {
    for (const client of this.clients) {
      const tool = client.tools.find((t) => t.name === prefixedName);
      if (tool) return client.callTool(tool.originalName, args);
    }
    return `Herramienta MCP desconocida: ${prefixedName}`;
  }

  closeAll(): void {
    for (const c of this.clients) c.close();
    this.clients = [];
  }
}
