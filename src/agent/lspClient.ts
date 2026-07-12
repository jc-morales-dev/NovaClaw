/**
 * lspClient.ts — Cliente LSP (Language Server Protocol) crudo sobre stdio.
 * Es el núcleo de la "inteligencia de código" de NovaClaw (fase 3): habla
 * JSON-RPC 2.0 con Content-Length framing con un language server (p.ej.
 * typescript-language-server --stdio), correlaciona pedidos↔respuestas, y
 * responde los pedidos server→cliente para que el server no se cuelgue.
 *
 * SOLO-Node (node:child_process). No importar desde el bundle del WebView.
 * El framing (encodeMessage / LspMessageBuffer) es puro y testeable sin proceso.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export type JsonRpcMessage = Record<string, any>;

/** Serializa un mensaje LSP con su cabecera Content-Length (bytes). */
export function encodeMessage(message: JsonRpcMessage): string {
  const json = JSON.stringify(message);
  const length = Buffer.byteLength(json, 'utf8');
  return `Content-Length: ${length}\r\n\r\n${json}`;
}

/**
 * Acumulador de bytes que extrae mensajes LSP completos a medida que llegan
 * (los chunks de stdout no respetan los límites de mensaje). PURO y testeable.
 */
export class LspMessageBuffer {
  private buf: Buffer = Buffer.alloc(0);

  append(chunk: Buffer | string): JsonRpcMessage[] {
    const asBuf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.buf = Buffer.concat([this.buf, asBuf]);
    const out: JsonRpcMessage[] = [];

    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = this.buf.subarray(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Cabecera sin Content-Length: la descartamos para no trabarnos.
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const length = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + length) break; // falta cuerpo → esperar
      const body = this.buf.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buf = this.buf.subarray(bodyStart + length);
      try {
        out.push(JSON.parse(body));
      } catch {
        // cuerpo no-JSON: lo ignoramos
      }
    }
    return out;
  }
}

type Pending = {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Conexión a un language server ya spawneado. Maneja el ciclo request/response
 * y responde automáticamente los pedidos que inicia el server (configuration,
 * registerCapability, workDoneProgress) para que no se bloquee.
 */
export class LspConnection {
  private child: ChildProcessWithoutNullStreams;
  private buffer = new LspMessageBuffer();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  /** Última tanda de diagnósticos por uri (textDocument/publishDiagnostics). */
  readonly diagnostics = new Map<string, any[]>();

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.child.stdout.on('data', (chunk: Buffer) => {
      for (const msg of this.buffer.append(chunk)) this.handle(msg);
    });
    this.child.on('exit', () => this.failAll(new Error('language server exited')));
    this.child.on('error', (err) => this.failAll(err));
  }

  private handle(msg: JsonRpcMessage): void {
    // Respuesta a un pedido nuestro.
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'LSP error'));
      else p.resolve(msg.result);
      return;
    }
    // Pedido iniciado por el server → hay que contestar o se cuelga.
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      let result: any = null;
      if (msg.method === 'workspace/configuration') {
        const items = Array.isArray(msg.params?.items) ? msg.params.items : [];
        result = items.map(() => ({}));
      } else if (msg.method === 'client/registerCapability' || msg.method === 'client/unregisterCapability') {
        result = null;
      }
      this.write({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    // Notificación server→cliente.
    if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri) {
      this.diagnostics.set(msg.params.uri, msg.params.diagnostics ?? []);
    }
  }

  private write(message: JsonRpcMessage): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(encodeMessage(message));
    } catch {
      // stdin cerrado: los pending caerán por timeout/exit
    }
  }

  private failAll(err: Error): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  request(method: string, params: any, timeoutMs = 15000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: any): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  dispose(): void {
    this.failAll(new Error('disposed'));
    try {
      this.child.kill();
    } catch {
      // ya muerto
    }
  }
}
