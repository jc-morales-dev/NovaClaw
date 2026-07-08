import express from 'express';
// vite se importa dinámicamente solo en dev (ver startServer). Así el bundle de
// producción para Android no arrastra vite (que no se usa en prod).
import fs from 'node:fs';
import path from 'node:path';
import { exec as execCallback, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { createAgentRuntime, createAgentSession, type AgentSession } from './src/agent/runtime';
import { createNativeAgentRuntime } from './src/agent/nativeAgent';
import { createLocalToolExecutor } from './src/agent/tools';
import { PROVIDERS, getProvider } from './src/agent/providers';
import { verifyAndListModels } from './src/agent/modelClient';

// Configuración del proveedor de IA. Mutable en runtime para que la pantalla de
// Ajustes pueda cambiar baseUrl/apiKey/model SIN reiniciar el agente ni recompilar.
// Modelo BYOK: la key SIEMPRE la trae el usuario (Ajustes → novaclaw.config.json)
// o la env var en dev. Nunca se embebe una key en el binario distribuido.
//   1. ZEN_API_KEY env var (dev/CI; en Android la setea RuntimeManager desde el config)
//   2. novaclaw.config.json (lo que el usuario guardó desde Ajustes)
//   3. Vacío → arranca el fallback heurístico local
const zenConfig = {
  provider: process.env.NOVACLAW_PROVIDER || 'opencode-zen',
  apiKey: process.env.ZEN_API_KEY || '',
  // minimax-m2.5-free fue discontinuado. Default a un modelo vigente y económico.
  baseUrl: process.env.ZEN_BASE_URL ?? 'https://opencode.ai/zen/v1',
  model: process.env.ZEN_MODEL ?? 'claude-haiku-4-5',
};

/** Mantiene baseUrl coherente con el proveedor elegido. */
function syncBaseUrlToProvider() {
  const provider = getProvider(zenConfig.provider);
  if (provider) zenConfig.baseUrl = provider.baseUrl;
}
const DEFAULT_CWD = process.cwd();
// Archivo persistente de config (fuera de git). RuntimeManager lo lee al arrancar;
// acá lo escribimos cuando el usuario guarda desde Ajustes, así sobrevive reinicios.
const NOVACLAW_CONFIG_PATH = process.env.NOVACLAW_CONFIG
  || path.join(process.env.HOME || DEFAULT_CWD, '..', 'novaclaw.config.json');
const AGENT_SESSION_ID = 'nova-chat-session';
const execAsync = promisify(execCallback);

/** Lee novaclaw.config.json (si existe) y lo mergea sobre zenConfig. */
function loadConfigFromFile() {
  try {
    if (!fs.existsSync(NOVACLAW_CONFIG_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(NOVACLAW_CONFIG_PATH, 'utf8'));
    if (typeof raw.provider === 'string' && raw.provider.trim()) zenConfig.provider = raw.provider.trim();
    if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) zenConfig.baseUrl = raw.baseUrl.trim();
    if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) zenConfig.apiKey = raw.apiKey.trim();
    if (typeof raw.model === 'string' && raw.model.trim()) zenConfig.model = raw.model.trim();
    syncBaseUrlToProvider();
  } catch (error: any) {
    console.error('No se pudo leer novaclaw.config.json:', error?.message);
  }
}

/** Persiste zenConfig a novaclaw.config.json (para que sobreviva reinicios del agente). */
function saveConfigToFile() {
  try {
    fs.writeFileSync(
      NOVACLAW_CONFIG_PATH,
      JSON.stringify({ provider: zenConfig.provider, baseUrl: zenConfig.baseUrl, apiKey: zenConfig.apiKey, model: zenConfig.model }, null, 2),
      'utf8',
    );
  } catch (error: any) {
    console.error('No se pudo guardar novaclaw.config.json:', error?.message);
    throw error;
  }
}

loadConfigFromFile();

type ChatRole = 'user' | 'assistant' | 'system';

type ModuleRuntimeStatus = 'stopped' | 'installing' | 'running';

type RuntimeSnapshot = {
  agent: {
    status: 'stopped' | 'running';
    mode: 'remote' | 'local';
    label: string;
    lastStartedAt: string | null;
  };
  opencode: {
    status: ModuleRuntimeStatus;
    installed: boolean;
    available: boolean;
    version: string | null;
    commandPath: string | null;
    message: string;
    lastExitCode: number | null;
    lastStartedAt: string | null;
  };
  terminal: {
    status: 'ready';
    cwd: string;
  };
};

const agentSessions = new Map<string, AgentSession>();

// Persistencia de conversaciones: viven junto a la config para sobrevivir a
// cierres de la app y reinicios del servicio (antes se perdían al reabrir).
const SESSIONS_PATH = path.join(path.dirname(NOVACLAW_CONFIG_PATH), 'novaclaw.sessions.json');

function loadSessionsFromDisk() {
  try {
    if (!fs.existsSync(SESSIONS_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const [id, session] of Object.entries(raw)) {
        agentSessions.set(id, session as AgentSession);
      }
    }
  } catch (error) {
    console.error('No se pudieron cargar las conversaciones guardadas:', error);
  }
}

function saveSessionsToDisk() {
  try {
    const obj: Record<string, AgentSession> = {};
    for (const [id, session] of agentSessions.entries()) obj[id] = session;
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify(obj), 'utf8');
  } catch (error) {
    console.error('No se pudieron guardar las conversaciones:', error);
  }
}

const MAX_LOGS = 200;
const systemLogs: string[] = [];

const runtimeState: RuntimeSnapshot = {
  agent: {
    status: 'stopped',
    mode: zenConfig.apiKey ? 'remote' : 'local',
    label: zenConfig.apiKey ? 'Listo para usar el modelo remoto.' : 'Modo local de respaldo activo.',
    lastStartedAt: null,
  },
  opencode: {
    status: 'stopped',
    installed: false,
    available: false,
    version: null,
    commandPath: null,
    message: 'Comprobando OpenCode…',
    lastExitCode: null,
    lastStartedAt: null,
  },
  terminal: {
    status: 'ready',
    cwd: DEFAULT_CWD,
  },
};

let opencodeInstallProcess: ChildProcessWithoutNullStreams | null = null;
let opencodeRuntimeProcess: ChildProcessWithoutNullStreams | null = null;

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${zenConfig.apiKey}`,
  };
}

async function resolveOpenCodeBinary(): Promise<string | null> {
  const commands = process.platform === 'win32'
    ? ['where.exe opencode.cmd', 'where.exe opencode']
    : ['which opencode'];

  for (const command of commands) {
    try {
      const { stdout } = await execAsync(command, { cwd: DEFAULT_CWD, timeout: 10000 });
      const binaryPath = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);

      if (binaryPath) {
        return binaryPath;
      }
    } catch {
      // Try the next resolution strategy.
    }
  }

  return null;
}

async function getOpenCodeVersion(binaryPath: string): Promise<string | null> {
  try {
    const quotedPath = binaryPath.includes(' ') ? `"${binaryPath}"` : binaryPath;
    const { stdout, stderr } = await execAsync(`${quotedPath} --version`, { cwd: DEFAULT_CWD, timeout: 10000 });
    const versionText = [stdout, stderr]
      .join('\n')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    return versionText || null;
  } catch {
    return null;
  }
}

async function refreshOpenCodeAvailability() {
  const binaryPath = await resolveOpenCodeBinary();
  const version = binaryPath ? await getOpenCodeVersion(binaryPath) : null;
  const isInstalling = Boolean(opencodeInstallProcess);
  const isRunning = Boolean(opencodeRuntimeProcess);

  runtimeState.opencode.installed = Boolean(binaryPath);
  runtimeState.opencode.available = Boolean(binaryPath);
  runtimeState.opencode.commandPath = binaryPath;
  runtimeState.opencode.version = version;

  if (isInstalling) {
    runtimeState.opencode.status = 'installing';
    if (!runtimeState.opencode.message) {
      runtimeState.opencode.message = 'Instalando OpenCode con npm…';
    }
    return;
  }

  if (isRunning) {
    runtimeState.opencode.status = 'running';
    runtimeState.opencode.message = binaryPath
      ? 'OpenCode está ejecutándose.'
      : 'OpenCode está ejecutándose.';
    return;
  }

  runtimeState.opencode.status = 'stopped';
  runtimeState.opencode.message = binaryPath
    ? `OpenCode detectado${version ? ` (${version})` : ''}.`
    : 'OpenCode no está instalado. Al iniciarlo se instala solo.';
}

function appendOpenCodeMessage(message: string) {
  const trimmed = message.trim();
  if (trimmed) {
    runtimeState.opencode.message = trimmed;
  }
}

// Carga las conversaciones persistidas al arrancar el agente.
loadSessionsFromDisk();

function getOrCreateSession(sessionId: string): AgentSession {
  const existing = agentSessions.get(sessionId);
  if (existing) {
    return existing;
  }

  const session = createAgentSession(sessionId, DEFAULT_CWD);
  agentSessions.set(sessionId, session);
  return session;
}

function overrideConsole() {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;

  function addLog(level: string, args: unknown[]) {
    const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
    const message = args
      .map((value) => (typeof value === 'object' ? JSON.stringify(value) : String(value)))
      .join(' ');

    systemLogs.push(`[${timestamp}] [${level}] ${message}`);
    if (systemLogs.length > MAX_LOGS) {
      systemLogs.shift();
    }
  }

  console.log = (...args) => {
    addLog('INFO', args);
    originalLog(...args);
  };

  console.error = (...args) => {
    addLog('ERROR', args);
    originalError(...args);
  };

  console.warn = (...args) => {
    addLog('WARN', args);
    originalWarn(...args);
  };

  console.info = (...args) => {
    addLog('INFO', args);
    originalInfo(...args);
  };
}

overrideConsole();

function createMessageAction(message: string) {
  return JSON.stringify({ kind: 'message', message });
}

function createToolCallAction(tool: string, argumentsValue: Record<string, unknown>) {
  return JSON.stringify({ kind: 'tool_call', tool, arguments: argumentsValue });
}

function isLikelySpanish(text: string): boolean {
  return /[áéíóúñ]|\b(hola|archivo|carpeta|directorio|crear|crea|muestra|lista|ejecuta|comando|donde|estoy|busca|ayuda)\b/i.test(text);
}

function truncateOutput(value: string, maxLength = 1200): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...`;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function buildToolSummaryMessage(rawContent: string, spanish: boolean): string | null {
  if (rawContent.startsWith('User rejected tool call:')) {
    return spanish
      ? 'Entendido. No ejecutaré esa acción sensible sin tu permiso.'
      : 'Understood. I will not execute that sensitive action without your approval.';
  }

  const parsed = safeJsonParse(rawContent);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const result = parsed as Record<string, unknown>;
  const toolName = String(result.tool ?? result.name ?? 'tool');
  const output = String(result.output ?? '');
  const status = String(result.status ?? 'success');
  const header = spanish ? `Resultado de \`${toolName}\`` : `Result from \`${toolName}\``;
  const statusLabel = status === 'error'
    ? (spanish ? 'La acción falló.' : 'The action failed.')
    : (spanish ? 'La acción terminó correctamente.' : 'The action completed successfully.');
  const body = output.trim()
    ? `\n\n\`\`\`\n${truncateOutput(output.trim())}\n\`\`\``
    : '';

  return `${header}\n\n${statusLabel}${body}`;
}

function resolveInstructionPath(rawPath: string, cwd: string): string {
  if (!rawPath) {
    return cwd;
  }

  if (rawPath === '~') {
    return DEFAULT_CWD;
  }

  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

function buildLocalAgentAction(input: {
  messages: Array<{ role: ChatRole; content: string }>;
  cwd: string;
  workspaceRoot: string;
}) {
  const lastUserMessage = [...input.messages].reverse().find((entry) => entry.role === 'user')?.content ?? '';
  const spanish = isLikelySpanish(lastUserMessage);
  const latestHistoryEntry = input.messages[input.messages.length - 1];

  if (latestHistoryEntry?.role === 'system') {
    const summaryMessage = buildToolSummaryMessage(latestHistoryEntry.content, spanish);
    if (summaryMessage) {
      return createMessageAction(summaryMessage);
    }
  }

  const normalized = lastUserMessage.trim();
  const lower = normalized.toLowerCase();

  if (!normalized) {
    return createMessageAction(
      spanish
        ? 'Estoy listo para ayudarte a inspeccionar archivos, ejecutar comandos o crear estructura de proyecto.'
        : 'I am ready to inspect files, run commands, or create project structure.',
    );
  }

  if (/^(pwd|where am i|current dir|directorio actual|donde estoy)$/i.test(normalized)) {
    return createToolCallAction('terminal.run', { command: 'pwd' });
  }

  if (/^(ls|dir)(\s+.*)?$/i.test(normalized)) {
    return createToolCallAction('terminal.run', { command: normalized });
  }

  if (/^(cat|type)\s+.+$/i.test(normalized)) {
    return createToolCallAction('terminal.run', { command: normalized });
  }

  if (/^(node|npm|python|git)\b/i.test(normalized)) {
    return createToolCallAction('terminal.run', { command: normalized });
  }

  const explicitRunMatch = normalized.match(/^(?:run|exec|execute|terminal|cmd|comando)\s+(.+)$/i);
  if (explicitRunMatch) {
    return createToolCallAction('terminal.run', { command: explicitRunMatch[1] });
  }

  if (
    /(lista|muestra|show|list).*(archivos|files|carpetas|folders)/i.test(lower)
    || /(que hay|what is in).*(directorio|folder|workspace)/i.test(lower)
  ) {
    return createToolCallAction('terminal.run', { command: 'ls' });
  }

  const readMatch = normalized.match(/(?:read|open|show|lee|abre|muestra)\s+(?:file\s+|archivo\s+)?(.+)$/i);
  if (readMatch) {
    return createToolCallAction('file.read', { path: readMatch[1].trim() });
  }

  const mkdirMatch = normalized.match(/(?:mkdir|create|make|crear|crea)\s+(?:folder|directory|carpeta|directorio)\s+(.+)$/i);
  if (mkdirMatch) {
    return createToolCallAction('workspace.mkdir', { path: mkdirMatch[1].trim() });
  }

  const writeMatch = normalized.match(
    /(?:write|create|crear|crea)\s+(?:file|archivo)\s+([^\s]+)(?:\s+(?:with|content|contenido)\s+([\s\S]+))?$/i,
  );
  if (writeMatch) {
    return createToolCallAction('file.write', {
      path: writeMatch[1].trim(),
      content: writeMatch[2]?.trim() ?? '',
    });
  }

  const searchMatch = normalized.match(/(?:search|find|buscar)\s+([^\s]+)(?:\s+(?:in|en)\s+(.+))?$/i);
  if (searchMatch) {
    return createToolCallAction('file.search', {
      query: searchMatch[1].trim(),
      path: searchMatch[2]?.trim() || '.',
    });
  }

  return createMessageAction(
    spanish
      ? 'Estoy funcionando en modo local. Puedo ejecutar comandos, leer archivos, crear carpetas y escribir archivos si me lo pides de forma directa.'
      : 'I am running in local mode. I can run commands, read files, create folders, and write files when you ask directly.',
  );
}

async function callZenAgent(input: {
  systemPrompt: string;
  messages: Array<{ role: ChatRole; content: string }>;
  cwd: string;
  workspaceRoot: string;
}) {
  if (!zenConfig.apiKey) {
    return buildLocalAgentAction(input);
  }

  const messages = [
    {
      role: 'system' as const,
      content: `${input.systemPrompt}

Current cwd: ${input.cwd}
Workspace root: ${input.workspaceRoot}

When the user asks to inspect files, run commands, create folders, or edit content, prefer a tool call over a generic answer.
If a requested action may be sensitive, still emit the exact tool_call and let the runtime ask the user for approval.
Return JSON only.`,
    },
    ...input.messages,
  ];

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const controller = new AbortController();
      // Configurable: algunos modelos free/razonadores tardan más de 30s.
      const timeoutMs = Number(process.env.ZEN_TIMEOUT_MS) || 90000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(`${zenConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: getHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          model: zenConfig.model,
          messages,
          temperature: 0.2,
          max_tokens: Number(process.env.ZEN_MAX_TOKENS) || 2048,
        }),
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Zen API Error:', response.status, errorText);

        if (response.status >= 500 && attempt < maxRetries) {
          console.log(`Retrying Zen API call (attempt ${attempt + 1}/${maxRetries})...`);
          continue;
        }

        runtimeState.agent.mode = 'local';
        runtimeState.agent.label = 'Modelo remoto no disponible. Modo local de respaldo activo.';
        return buildLocalAgentAction(input);
      }

      const data = await response.json();
      const assistantMessage = data.choices?.[0]?.message?.content?.trim();

      if (!assistantMessage) {
        runtimeState.agent.mode = 'local';
        runtimeState.agent.label = 'El modelo remoto no devolvió contenido. Modo local de respaldo activo.';
        return buildLocalAgentAction(input);
      }

      runtimeState.agent.mode = 'remote';
      runtimeState.agent.label = 'Modelo remoto en línea.';
      return assistantMessage;
    } catch (error: any) {
      console.error('Zen Error:', error.message, '| cause:', error?.cause?.code || error?.cause?.message || 'n/a', '| url:', `${zenConfig.baseUrl}/chat/completions`);

      if (attempt < maxRetries && (error.name === 'AbortError' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT')) {
        console.log(`Retrying Zen API call after network error (attempt ${attempt + 1}/${maxRetries})...`);
        continue;
      }

      runtimeState.agent.mode = 'local';
      runtimeState.agent.label = 'No se pudo contactar el modelo remoto. Modo local de respaldo activo.';
      return buildLocalAgentAction(input);
    }
  }

  runtimeState.agent.mode = 'local';
  runtimeState.agent.label = 'Modelo remoto no disponible tras varios intentos. Modo local de respaldo activo.';
  return buildLocalAgentAction(input);
}

function getRuntimeSnapshot() {
  return {
    ...runtimeState,
    agent: { ...runtimeState.agent },
    opencode: { ...runtimeState.opencode },
    terminal: { ...runtimeState.terminal },
  };
}

function startAgentRuntime() {
  runtimeState.agent.status = 'running';
  runtimeState.agent.lastStartedAt = new Date().toISOString();
  runtimeState.agent.mode = zenConfig.apiKey ? 'remote' : 'local';
  runtimeState.agent.label = zenConfig.apiKey
    ? 'Modelo remoto en línea.'
    : 'Modo local de respaldo activo.';
}

async function startOpenCodeInstall() {
  if (opencodeInstallProcess) {
    return;
  }

  runtimeState.opencode.status = 'installing';
  runtimeState.opencode.lastStartedAt = new Date().toISOString();
  runtimeState.opencode.lastExitCode = null;
  runtimeState.opencode.message = 'Instalando OpenCode con npm…';

  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  opencodeInstallProcess = spawn(command, ['install', '-g', 'opencode-ai'], {
    cwd: DEFAULT_CWD,
    env: process.env,
  });

  opencodeInstallProcess.stdout.on('data', (chunk) => {
    appendOpenCodeMessage(String(chunk));
  });

  opencodeInstallProcess.stderr.on('data', (chunk) => {
    appendOpenCodeMessage(String(chunk));
  });

  opencodeInstallProcess.on('error', async (error) => {
    opencodeInstallProcess = null;
    runtimeState.opencode.lastExitCode = -1;
    runtimeState.opencode.status = 'stopped';
    runtimeState.opencode.message = `OpenCode install failed: ${error.message}`;
    await refreshOpenCodeAvailability();
  });

  opencodeInstallProcess.on('close', async (code) => {
    opencodeInstallProcess = null;
    runtimeState.opencode.lastExitCode = code ?? null;
    await refreshOpenCodeAvailability();
    runtimeState.opencode.message = code === 0
      ? 'OpenCode instalado con éxito. Tocá Iniciar de nuevo para abrirlo.'
      : `La instalación de OpenCode falló (código ${code ?? 'desconocido'}).`;
  });
}

async function startOpenCodeRuntime() {
  if (opencodeRuntimeProcess || opencodeInstallProcess) {
    return;
  }

  await refreshOpenCodeAvailability();
  const binaryPath = runtimeState.opencode.commandPath;

  if (!binaryPath) {
    await startOpenCodeInstall();
    return;
  }

  runtimeState.opencode.status = 'running';
  runtimeState.opencode.lastStartedAt = new Date().toISOString();
  runtimeState.opencode.lastExitCode = null;
  runtimeState.opencode.message = 'Abriendo OpenCode…';

  opencodeRuntimeProcess = spawn(binaryPath, [], {
    cwd: DEFAULT_CWD,
    env: process.env,
  });

  opencodeRuntimeProcess.stdout.on('data', (chunk) => {
    appendOpenCodeMessage(String(chunk));
  });

  opencodeRuntimeProcess.stderr.on('data', (chunk) => {
    appendOpenCodeMessage(String(chunk));
  });

  opencodeRuntimeProcess.on('error', async (error) => {
    opencodeRuntimeProcess = null;
    runtimeState.opencode.lastExitCode = -1;
    runtimeState.opencode.status = 'stopped';
    runtimeState.opencode.message = `OpenCode failed to launch: ${error.message}`;
    await refreshOpenCodeAvailability();
  });

  opencodeRuntimeProcess.on('close', async (code) => {
    opencodeRuntimeProcess = null;
    runtimeState.opencode.lastExitCode = code ?? null;
    runtimeState.opencode.status = 'stopped';
    await refreshOpenCodeAvailability();
    runtimeState.opencode.message = code === 0
      ? 'OpenCode se cerró normalmente.'
      : `OpenCode se cerró con código ${code ?? 'desconocido'}.`;
  });
}

async function stopOpenCodeRuntime() {
  if (opencodeInstallProcess) {
    opencodeInstallProcess.kill();
    opencodeInstallProcess = null;
  }

  if (opencodeRuntimeProcess) {
    opencodeRuntimeProcess.kill();
    opencodeRuntimeProcess = null;
  }

  runtimeState.opencode.lastExitCode = null;
  await refreshOpenCodeAvailability();
}

function isExistingDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function formatDirectoryEntries(targetPath: string): string {
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  if (entries.length === 0) {
    return '(empty)';
  }

  return entries
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .join('  ');
}

// Runtime local heurístico (sin API key): protocolo simple de respaldo.
const localAgentRuntime = createAgentRuntime({
  workspaceRoot: DEFAULT_CWD,
  callModel: callZenAgent,
  executeToolCall: createLocalToolExecutor(),
  maxIterations: 18,
});

// Runtime PRO con function-calling nativo (cuando hay API key). Es el que hace
// que el agente se sienta como Codex/Claude Code: encadena herramientas reales.
const nativeAgentRuntime = createNativeAgentRuntime({
  workspaceRoot: DEFAULT_CWD,
  getConfig: () => ({ providerId: zenConfig.provider, apiKey: zenConfig.apiKey, model: zenConfig.model }),
  executeToolCall: createLocalToolExecutor(),
  onRemote: (label) => {
    runtimeState.agent.mode = 'remote';
    runtimeState.agent.label = label;
  },
  maxIterations: 32,
  // Memoria persistente del proyecto (como CLAUDE.md): el agente la lee en cada
  // turno y la actualiza él mismo cuando el usuario le enseña algo duradero.
  getProjectContext: () => {
    try {
      const memoryPath = path.join(DEFAULT_CWD, 'NOVACLAW.md');
      return fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf8') : '';
    } catch {
      return '';
    }
  },
});

/** Elige el runtime: nativo si hay key, local heurístico si no. */
function pickRuntime() {
  return zenConfig.apiKey ? nativeAgentRuntime : localAgentRuntime;
}

// ── Terminal PTY real (WebSocket) ──────────────────────────────────────────
// Usa el truco de `script` (util-linux) para asignar un PTY real SIN código
// nativo: `script -q -c "stty ...; exec $SHELL -il" /dev/null` corre un shell
// interactivo dentro de una pseudo-terminal (/dev/pts/N), así vim/htop/tail -f
// funcionan de verdad. El WebSocket transporta la E/S hacia el xterm.js de la UI.
// Protocolo (mensajes JSON): {type:'input',data} y {type:'resize',cols,rows}.
function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function attachPtyWebSocket(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: '/pty' });

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '/pty', 'http://localhost');
    const cols = clampInt(url.searchParams.get('cols'), 80, 20, 500);
    const rows = clampInt(url.searchParams.get('rows'), 24, 5, 300);

    const shell = process.env.SHELL || '/system/bin/sh';
    const scriptBin = process.env.PREFIX ? `${process.env.PREFIX}/bin/script` : 'script';
    // stty fija el tamaño del pts al del xterm; luego exec del shell interactivo.
    const inner = `stty rows ${rows} cols ${cols} 2>/dev/null; exec ${shell} -il`;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(scriptBin, ['-q', '-c', inner, '/dev/null'], {
        cwd: process.env.HOME || DEFAULT_CWD,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
    } catch (error: any) {
      try { ws.send(`\r\n\x1b[31mNo se pudo abrir la terminal: ${error?.message}\x1b[0m\r\n`); } catch {}
      ws.close();
      return;
    }

    const sendOut = (buf: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(buf.toString('utf8'));
    };
    child.stdout.on('data', sendOut);
    child.stderr.on('data', sendOut);

    child.on('exit', (code) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\n\x1b[33m[proceso terminó con código ${code ?? 0}]\x1b[0m\r\n`);
        ws.close();
      }
    });

    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.type === 'input' && typeof msg.data === 'string') {
        child.stdin.write(msg.data);
      }
      // El resize en vivo se omite a propósito: el pts lo posee `script` y no se
      // puede redimensionar desde node sin inyectar `stty` (que ensuciaría apps a
      // pantalla completa). El tamaño inicial ya se fija con el cols/rows del xterm.
    });

    ws.on('close', () => {
      try { child.kill('SIGHUP'); } catch {}
    });
  });

  console.log('PTY WebSocket listo en /pty');
}

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  app.use(express.json());

  app.get('/api/runtime/status', async (_req, res) => {
    if (!opencodeInstallProcess && !opencodeRuntimeProcess) {
      await refreshOpenCodeAvailability();
    }
    res.json(getRuntimeSnapshot());
  });

  app.get('/api/logs', (_req, res) => {
    res.json({ logs: systemLogs });
  });

  app.delete('/api/logs', (_req, res) => {
    systemLogs.length = 0;
    res.json({ success: true });
  });

  let userSettings: Record<string, unknown> = {};

  app.get('/api/settings', (_req, res) => {
    res.json(userSettings);
  });

  app.post('/api/settings', (req, res) => {
    userSettings = { ...userSettings, ...req.body };
    res.json({ success: true });
  });

  app.post('/api/agent/start', (_req, res) => {
    startAgentRuntime();
    console.log(`Agent started successfully in ${runtimeState.agent.mode} mode.`);
    res.json({
      success: true,
      agent: runtimeState.agent,
    });
  });

  app.post('/api/opencode/start', async (_req, res) => {
    await startOpenCodeRuntime();
    return res.json({ success: true, opencode: runtimeState.opencode });
  });

  app.post('/api/opencode/stop', async (_req, res) => {
    await stopOpenCodeRuntime();
    res.json({ success: true, opencode: runtimeState.opencode });
  });

  app.post('/api/chat', async (req, res) => {
    const { message, sessionId = AGENT_SESSION_ID } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (runtimeState.agent.status !== 'running') {
      startAgentRuntime();
    }

    console.log(`[Chat] Session: ${sessionId}, Message: ${message.substring(0, 100)}...`);

    try {
      const session = getOrCreateSession(sessionId);
      const result = await pickRuntime().runUserTurn(session, message);
      runtimeState.terminal.cwd = session.cwd;
      saveSessionsToDisk();
      return res.json({ events: result.events });
    } catch (error: any) {
      console.error('Chat API Error:', error);
      return res.status(500).json({
        events: [
          {
            type: 'message',
            message: `Error del agente: ${error.message}`,
          },
        ],
      });
    }
  });

  // ── Streaming en vivo (SSE): los eventos del agente llegan a medida que
  // ocurren (mensajes, tool calls, aprobaciones), como en Claude Code. ──────
  function openSse(res: import('express').Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    return (eventName: string, payload: unknown) => {
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
  }

  app.post('/api/chat/stream', async (req, res) => {
    const { message, sessionId = AGENT_SESSION_ID } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }
    if (runtimeState.agent.status !== 'running') {
      startAgentRuntime();
    }
    // Botón Detener: si el cliente cierra la conexión, abortamos el turno.
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    const send = openSse(res);
    try {
      const session = getOrCreateSession(sessionId);
      const result = await pickRuntime().runUserTurn(session, message, (ev) => send('agent', ev), controller.signal);
      runtimeState.terminal.cwd = session.cwd;
      saveSessionsToDisk();
      send('done', { count: result.events.length });
    } catch (error: any) {
      console.error('Chat stream error:', error);
      send('agent', { type: 'message', message: `Error del agente: ${error.message}` });
      send('done', { error: error.message });
    }
    res.end();
  });

  app.post('/api/chat/approval/stream', async (req, res) => {
    const { sessionId = AGENT_SESSION_ID, approved } = req.body;
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    const send = openSse(res);
    try {
      const session = getOrCreateSession(sessionId);
      const result = await pickRuntime().resolveApproval(session, Boolean(approved), (ev) => send('agent', ev), controller.signal);
      runtimeState.terminal.cwd = session.cwd;
      saveSessionsToDisk();
      send('done', { count: result.events.length });
    } catch (error: any) {
      console.error('Approval stream error:', error);
      send('agent', { type: 'message', message: `Error resolviendo aprobacion: ${error.message}` });
      send('done', { error: error.message });
    }
    res.end();
  });

  app.post('/api/chat/approval', async (req, res) => {
    const { sessionId = AGENT_SESSION_ID, approved } = req.body;

    try {
      const session = getOrCreateSession(sessionId);
      const result = await pickRuntime().resolveApproval(session, Boolean(approved));
      runtimeState.terminal.cwd = session.cwd;
      saveSessionsToDisk();
      return res.json({ events: result.events });
    } catch (error: any) {
      console.error('Approval API Error:', error);
      return res.status(500).json({
        events: [
          {
            type: 'message',
            message: `Error resolviendo aprobacion: ${error.message}`,
          },
        ],
      });
    }
  });

  app.post('/api/chat/reset', (req, res) => {
    const { sessionId = AGENT_SESSION_ID } = req.body;
    agentSessions.delete(sessionId);
    saveSessionsToDisk();
    runtimeState.terminal.cwd = DEFAULT_CWD;
    res.json({ success: true });
  });

  // Config del proveedor de IA desde la UI (reemplaza el push manual por USB).
  // NUNCA devolvemos la apiKey; solo si está seteada.
  app.get('/api/config', (_req, res) => {
    res.json({
      provider: zenConfig.provider,
      baseUrl: zenConfig.baseUrl,
      model: zenConfig.model,
      hasApiKey: !!zenConfig.apiKey,
      mode: zenConfig.apiKey ? 'remote' : 'local',
    });
  });

  app.post('/api/config', (req, res) => {
    const { provider, baseUrl, apiKey, model } = req.body ?? {};
    // Solo se actualizan los campos provistos. Un apiKey === '' limpia la key.
    if (typeof provider === 'string' && provider.trim() && getProvider(provider.trim())) {
      zenConfig.provider = provider.trim();
      syncBaseUrlToProvider();
    }
    if (typeof baseUrl === 'string' && baseUrl.trim()) zenConfig.baseUrl = baseUrl.trim();
    if (typeof model === 'string' && model.trim()) zenConfig.model = model.trim();
    if (typeof apiKey === 'string') zenConfig.apiKey = apiKey.trim();

    try {
      saveConfigToFile();
    } catch (error: any) {
      return res.status(500).json({ error: `No se pudo guardar la config: ${error?.message}` });
    }

    // Refleja el nuevo estado en el runtime sin reiniciar el agente.
    runtimeState.agent.mode = zenConfig.apiKey ? 'remote' : 'local';
    runtimeState.agent.label = zenConfig.apiKey
      ? 'Modelo remoto en línea.'
      : 'Modo local de respaldo activo.';

    res.json({
      success: true,
      provider: zenConfig.provider,
      baseUrl: zenConfig.baseUrl,
      model: zenConfig.model,
      hasApiKey: !!zenConfig.apiKey,
      mode: zenConfig.apiKey ? 'remote' : 'local',
    });
  });

  // Lista de proveedores disponibles para la UI.
  app.get('/api/providers', (_req, res) => {
    res.json({
      providers: PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        needsKey: p.needsKey,
        keyHint: p.keyHint,
        note: p.note ?? null,
      })),
      current: zenConfig.provider,
    });
  });

  // Verificación real: pega la key, elige proveedor, verificamos contra su
  // /models y devolvemos la lista viva de modelos. Nada de humo.
  app.post('/api/provider/verify', async (req, res) => {
    const { provider, apiKey } = req.body ?? {};
    const providerId = typeof provider === 'string' ? provider : zenConfig.provider;
    const key = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : zenConfig.apiKey;
    try {
      const result = await verifyAndListModels(providerId, key);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ ok: false, models: [], error: error?.message ?? 'Error verificando.' });
    }
  });

  app.get('/api/chat/history', (req, res) => {
    const sessionId = (req.query.sessionId as string) || AGENT_SESSION_ID;
    const session = getOrCreateSession(sessionId);
    res.json({ history: session.history, pendingApproval: session.pendingApproval });
  });

  app.post('/api/terminal', (req, res) => {
    const { command, cwd } = req.body;
    const requestedCwd = typeof cwd === 'string' && cwd.trim() ? cwd : runtimeState.terminal.cwd;
    const currentCwd = isExistingDirectory(requestedCwd) ? requestedCwd : DEFAULT_CWD;
    const trimmedCmd = String(command ?? '').trim();
    // En Android hay un shell Linux real ($PREFIX/bin/sh vía SHELL). Cuando existe,
    // mandamos todo al shell nativo y saltamos los builtins JS (que rompen
    // pipes, flags y &&). Solo mantenemos cd/pwd/clear para el estado de la UI.
    const nativeShell = !!process.env.SHELL;

    runtimeState.terminal.cwd = currentCwd;

    if (!trimmedCmd) {
      return res.json({ output: '', cwd: currentCwd });
    }

    if (trimmedCmd === 'cls' || trimmedCmd === 'clear') {
      return res.json({ output: '__CLEAR__', cwd: currentCwd });
    }

    if (!nativeShell && trimmedCmd === 'date') {
      return res.json({ output: new Date().toString(), cwd: currentCwd });
    }

    if (!nativeShell && trimmedCmd === 'whoami') {
      return res.json({ output: process.env.USERNAME || process.env.USER || 'unknown', cwd: currentCwd });
    }

    if (trimmedCmd === 'pwd') {
      return res.json({ output: currentCwd, cwd: currentCwd });
    }

    if (!nativeShell && trimmedCmd === 'help') {
      return res.json({
        output: `Available built-in commands:
  cls, clear    - Clear terminal screen
  date          - Show current date and time
  whoami        - Show current user
  pwd           - Show current directory
  cd <path>     - Change current directory
  ls [path]     - List directory contents
  cat <file>    - Display file contents
  echo <text>   - Print text to terminal
  node -v       - Show Node.js version
  npm -v        - Show npm version
  python -V     - Show Python version
  <any>         - Execute as shell command`,
        cwd: currentCwd,
      });
    }

    if (!nativeShell && trimmedCmd.startsWith('echo ')) {
      return res.json({ output: trimmedCmd.substring(5), cwd: currentCwd });
    }

    if (trimmedCmd === 'cd' || trimmedCmd === 'cd ~') {
      runtimeState.terminal.cwd = DEFAULT_CWD;
      return res.json({ output: '', cwd: DEFAULT_CWD });
    }

    if (trimmedCmd === 'cd .') {
      return res.json({ output: '', cwd: currentCwd });
    }

    if (trimmedCmd.startsWith('cd ')) {
      const destination = trimmedCmd.substring(3).trim();
      const newCwd = resolveInstructionPath(destination, currentCwd);

      if (!isExistingDirectory(newCwd)) {
        return res.json({ output: `cd: directory not found: ${destination}`, cwd: currentCwd });
      }

      runtimeState.terminal.cwd = newCwd;
      return res.json({ output: '', cwd: newCwd });
    }

    if (!nativeShell && trimmedCmd === 'ls') {
      try {
        return res.json({ output: formatDirectoryEntries(currentCwd), cwd: currentCwd });
      } catch (error: any) {
        return res.json({ output: `ls: ${error.message}`, cwd: currentCwd });
      }
    }

    if (!nativeShell && trimmedCmd.startsWith('ls ')) {
      const targetPath = resolveInstructionPath(trimmedCmd.substring(3).trim(), currentCwd);
      try {
        return res.json({ output: formatDirectoryEntries(targetPath), cwd: currentCwd });
      } catch (error: any) {
        return res.json({ output: `ls: ${error.message}`, cwd: currentCwd });
      }
    }

    if (!nativeShell && trimmedCmd.startsWith('cat ')) {
      const filePath = resolveInstructionPath(trimmedCmd.substring(4).trim(), currentCwd);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        return res.json({ output: content, cwd: currentCwd });
      } catch (error: any) {
        return res.json({ output: `cat: ${error.message}`, cwd: currentCwd });
      }
    }

    execCallback(command, { cwd: currentCwd, timeout: 15000, shell: process.env.SHELL || undefined }, (error, stdout, stderr) => {
      let output = stdout || '';
      if (stderr) {
        output += stderr;
      }
      if (error && !stderr && !stdout) {
        output += error.message;
      }
      res.json({ output, cwd: currentCwd });
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = process.env.NOVACLAW_DIST || path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${port}`);
  });

  attachPtyWebSocket(server);

  await refreshOpenCodeAvailability();
}

startServer();
