/**
 * lspManager.ts — Gestor de language servers para la "inteligencia de código"
 * (fase 3). Spawnea el server correcto por lenguaje (una vez por proyecto, se
 * reutiliza), hace el handshake initialize, y expone operaciones AGENT-FRIENDLY
 * por NOMBRE de símbolo (no por posición línea/columna, que el agente no sabe):
 *   - symbols(file)      → esquema del archivo (funciones/clases/… con su línea)
 *   - findSymbol(query)  → dónde se DEFINE un símbolo (workspace/symbol)
 *   - references(query)  → todos los usos de un símbolo
 *
 * Degrada con elegancia: si el server no está instalado, dice cómo instalarlo.
 * SOLO-Node (child_process). No importar desde el bundle del WebView.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { LspConnection } from './lspClient';

type ServerConfig = {
  key: string;
  command: string;
  args: string[];
  languageId: string;
  install: string;
};

// Servers por extensión. typescript-language-server cubre TS y JS.
const TS_SERVER: ServerConfig = {
  key: 'typescript',
  command: 'typescript-language-server',
  args: ['--stdio'],
  languageId: 'typescript',
  // 4.3.3 es la última que corre en Node 18 (5.x pide Node ≥20). Y typescript@5
  // (NO el 7.x nativo, que ya no trae lib/tsserver.js — el LSP no lo entiende).
  install: 'npm i -g typescript-language-server@4.3.3 typescript@5',
};

const SERVERS: Record<string, ServerConfig> = {
  '.ts': TS_SERVER,
  '.tsx': { ...TS_SERVER, languageId: 'typescriptreact' },
  '.js': { ...TS_SERVER, languageId: 'javascript' },
  '.jsx': { ...TS_SERVER, languageId: 'javascriptreact' },
  '.mjs': { ...TS_SERVER, languageId: 'javascript' },
  '.cjs': { ...TS_SERVER, languageId: 'javascript' },
};

const SYMBOL_KIND: Record<number, string> = {
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class', 6: 'Method',
  7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum', 11: 'Interface',
  12: 'Function', 13: 'Variable', 14: 'Constant', 15: 'String', 16: 'Number',
  17: 'Boolean', 18: 'Array', 19: 'Object', 20: 'Key', 21: 'Null',
  22: 'EnumMember', 23: 'Struct', 24: 'Event', 25: 'Operator', 26: 'TypeParameter',
};
const kindName = (k: number): string => SYMBOL_KIND[k] ?? 'Symbol';

export type IntelResult = { ok: boolean; text: string };

// ── Resolución de proyecto / binario ─────────────────────────────────────────

function findUp(startDir: string, names: string[]): string | null {
  let dir = startDir;
  for (let i = 0; i < 12; i += 1) {
    for (const name of names) {
      if (existsSync(path.join(dir, name))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function projectRoot(filePathOrDir: string): string {
  const dir = existsSync(filePathOrDir) && filePathOrDir.match(/\.[a-z]+$/i)
    ? path.dirname(filePathOrDir)
    : filePathOrDir;
  return findUp(dir, ['tsconfig.json', 'jsconfig.json', 'package.json', '.git']) ?? dir;
}

function resolveServerBin(root: string, command: string): string {
  const isWin = process.platform === 'win32';
  const local = path.join(root, 'node_modules', '.bin', command + (isWin ? '.cmd' : ''));
  return existsSync(local) ? local : command;
}

/**
 * Ubica el tsserver.js CLÁSICO (typescript 5.x) para pasárselo explícito al
 * language server. typescript-language-server no busca el typescript GLOBAL solo,
 * y el typescript 7.x nativo ni siquiera trae lib/tsserver.js. Devuelve la ruta
 * o undefined (y el LSP intenta autodescubrir).
 */
function findTsserverPath(root: string, binPath: string): string | undefined {
  const rel = ['typescript', 'lib', 'tsserver.js'];
  const candidates = [
    path.join(root, 'node_modules', ...rel),
    path.join('/usr/local/lib/node_modules', ...rel),
    path.join('/usr/lib/node_modules', ...rel),
  ];
  // Relativo al binario del LSP (…/node_modules/.bin → …/node_modules/typescript/lib/tsserver.js)
  if (binPath && binPath !== TS_SERVER.command) {
    candidates.push(path.resolve(path.dirname(binPath), '..', ...rel));
  }
  return candidates.find((c) => existsSync(c));
}

function initializeParams(root: string, tsserverPath?: string) {
  const uri = pathToFileURL(root).toString();
  return {
    processId: process.pid,
    clientInfo: { name: 'NovaClaw', version: '1.0.0' },
    rootUri: uri,
    workspaceFolders: [{ uri, name: 'workspace' }],
    // Apuntamos el tsserver clásico si lo encontramos (typescript@5).
    initializationOptions: tsserverPath ? { tsserver: { path: tsserverPath } } : undefined,
    capabilities: {
      textDocument: {
        synchronization: { didSave: false, dynamicRegistration: false },
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        references: {},
        definition: {},
        hover: { contentFormat: ['plaintext', 'markdown'] },
      },
      workspace: { symbol: {}, configuration: true, workspaceFolders: true },
    },
  };
}

// ── Ciclo de vida del server (spawn + initialize, cacheado por proyecto) ──────

const connections = new Map<string, Promise<LspConnection | null>>();
const openedByConn = new Map<LspConnection, Set<string>>();
// Motivo del último fallo de conexión (para dar un error preciso al agente).
let lastFail = '';

async function startConnection(root: string, cfg: ServerConfig): Promise<LspConnection | null> {
  const isWin = process.platform === 'win32';
  const bin = resolveServerBin(root, cfg.command);
  const tsserverPath = findTsserverPath(root, bin);
  // NODE_PATH con el node_modules global ayuda a que el LSP resuelva typescript.
  const nodeModulesDir = tsserverPath ? path.resolve(tsserverPath, '..', '..', '..') : '';
  const env = nodeModulesDir
    ? { ...process.env, NODE_PATH: [nodeModulesDir, process.env.NODE_PATH].filter(Boolean).join(path.delimiter) }
    : process.env;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, cfg.args, { cwd: root, shell: isWin, env });
  } catch (error: any) {
    lastFail = `Could not launch the language server (${error?.message ?? 'spawn error'}). Install it in the phone's Linux: ${cfg.install}`;
    return null;
  }

  const spawned = await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    child.once('error', () => done(false));
    child.once('spawn', () => done(true));
    setTimeout(() => done(true), 1500);
  });
  if (!spawned) {
    lastFail = `Language server not installed. Install it in the phone's Linux: ${cfg.install}`;
    return null;
  }

  const conn = new LspConnection(child);
  try {
    await conn.request('initialize', initializeParams(root, tsserverPath), 30000);
    conn.notify('initialized', {});
    openedByConn.set(conn, new Set());
    return conn;
  } catch (error: any) {
    conn.dispose();
    lastFail = `Language server started but failed to initialize (${error?.message ?? 'error'}). Node here is ${process.version}; if it needs a newer Node try: ${cfg.install}`;
    return null;
  }
}

function connectionError(cfg: ServerConfig): string {
  return lastFail || `Language server not available. Install it: ${cfg.install}`;
}

function getConnection(root: string, cfg: ServerConfig): Promise<LspConnection | null> {
  const key = `${root}::${cfg.key}`;
  const cached = connections.get(key);
  if (cached) return cached;

  // OJO: NO cacheamos los fallos. Si el server no estaba (aún no instalado) y
  // luego se instala, la próxima llamada debe reintentar en vez de devolver el
  // null viejo. Y si una conexión viva muere, se saca del cache para re-spawnear.
  const promise: Promise<LspConnection | null> = (async () => {
    const conn = await startConnection(root, cfg);
    if (!conn) {
      connections.delete(key);
      return null;
    }
    conn.onClose(() => {
      if (connections.get(key) === promise) connections.delete(key);
    });
    return conn;
  })();
  connections.set(key, promise);
  return promise;
}

async function ensureOpen(conn: LspConnection, filePath: string, languageId: string): Promise<void> {
  const opened = openedByConn.get(conn) ?? new Set<string>();
  if (opened.has(filePath)) return;
  let text = '';
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  conn.notify('textDocument/didOpen', {
    textDocument: { uri: pathToFileURL(filePath).toString(), languageId, version: 1, text },
  });
  opened.add(filePath);
  openedByConn.set(conn, opened);
}

/** Cierra todos los servers (para tests / apagado). */
export function shutdownLsp(): void {
  for (const [, promise] of connections) {
    promise.then((c) => c?.dispose()).catch(() => {});
  }
  connections.clear();
  openedByConn.clear();
}

// ── Formateo de resultados LSP a texto para el agente ────────────────────────

function locToStr(uri: string, range: any): string {
  let file = uri;
  try {
    file = fileURLToPath(uri);
  } catch {
    // dejamos el uri crudo
  }
  const line = (range?.start?.line ?? 0) + 1; // LSP es 0-based → mostramos 1-based
  return `${file}:${line}`;
}

function formatDocumentSymbols(result: any): string {
  if (!Array.isArray(result) || result.length === 0) return 'No symbols found in this file.';
  const lines: string[] = [];
  const walk = (nodes: any[], depth: number) => {
    for (const s of nodes) {
      const line = (s.range?.start?.line ?? s.location?.range?.start?.line ?? 0) + 1;
      lines.push(`${'  '.repeat(depth)}${kindName(s.kind)} ${s.name} — line ${line}`);
      if (Array.isArray(s.children) && s.children.length) walk(s.children, depth + 1);
    }
  };
  walk(result, 0);
  return lines.slice(0, 200).join('\n');
}

function formatSymbolInformation(result: any, query: string): string {
  if (!Array.isArray(result) || result.length === 0) return `No symbol matches "${query}".`;
  const lines = result.slice(0, 60).map((s: any) =>
    `${kindName(s.kind)} ${s.name} — ${locToStr(s.location?.uri, s.location?.range)}`);
  return lines.join('\n');
}

function formatReferences(result: any, name: string): string {
  if (!Array.isArray(result) || result.length === 0) return `No references found for "${name}".`;
  const lines = result.slice(0, 100).map((loc: any) => locToStr(loc.uri, loc.range));
  return `${result.length} reference(s) to "${name}":\n${lines.join('\n')}`;
}

// ── API pública (la usa el executor de tools) ────────────────────────────────

const notSupported = (ext: string): IntelResult => ({
  ok: false,
  text: `No language server configured for "${ext || 'this file type'}" (only TS/JS for now).`,
});

/** Esquema de un archivo: funciones/clases/variables con su línea. */
export async function documentSymbols(filePath: string): Promise<IntelResult> {
  const cfg = SERVERS[path.extname(filePath).toLowerCase()];
  if (!cfg) return notSupported(path.extname(filePath));
  const conn = await getConnection(projectRoot(filePath), cfg);
  if (!conn) return { ok: false, text: connectionError(cfg) };
  await ensureOpen(conn, filePath, cfg.languageId);
  try {
    const res = await conn.request('textDocument/documentSymbol', {
      textDocument: { uri: pathToFileURL(filePath).toString() },
    });
    return { ok: true, text: formatDocumentSymbols(res) };
  } catch (error: any) {
    return { ok: false, text: `LSP error: ${error?.message ?? 'documentSymbol failed'}` };
  }
}

function serverForScope(scopePath: string): { cfg: ServerConfig; root: string } {
  const ext = path.extname(scopePath).toLowerCase();
  const cfg = SERVERS[ext] ?? TS_SERVER; // find/references default a TS/JS
  return { cfg, root: projectRoot(scopePath) };
}

/** Dónde se DEFINE un símbolo por nombre (workspace/symbol). */
export async function findSymbol(query: string, scopePath: string): Promise<IntelResult> {
  const { cfg, root } = serverForScope(scopePath);
  const conn = await getConnection(root, cfg);
  if (!conn) return { ok: false, text: connectionError(cfg) };
  try {
    const res = await conn.request('workspace/symbol', { query });
    return { ok: true, text: formatSymbolInformation(res, query) };
  } catch (error: any) {
    return { ok: false, text: `LSP error: ${error?.message ?? 'workspace/symbol failed'}` };
  }
}

/** Todos los usos de un símbolo por nombre (busca su definición y pide references). */
export async function referencesFor(query: string, scopePath: string): Promise<IntelResult> {
  const { cfg, root } = serverForScope(scopePath);
  const conn = await getConnection(root, cfg);
  if (!conn) return { ok: false, text: connectionError(cfg) };
  try {
    const symbols = await conn.request('workspace/symbol', { query });
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return { ok: true, text: `No symbol named "${query}" to find references for.` };
    }
    const match = symbols.find((s: any) => s.name === query) ?? symbols[0];
    const loc = match.location;
    const filePath = (() => { try { return fileURLToPath(loc.uri); } catch { return ''; } })();
    if (filePath) await ensureOpen(conn, filePath, cfg.languageId);
    const refs = await conn.request('textDocument/references', {
      textDocument: { uri: loc.uri },
      position: loc.range.start,
      context: { includeDeclaration: true },
    });
    return { ok: true, text: formatReferences(refs, match.name) };
  } catch (error: any) {
    return { ok: false, text: `LSP error: ${error?.message ?? 'references failed'}` };
  }
}
