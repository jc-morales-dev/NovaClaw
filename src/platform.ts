/**
 * platform.ts — Capa de abstracción para Web y Android APK.
 *
 * Modo Web: fetch() contra el servidor Express local (server.ts).
 * Modo Android (Capacitor):
 * - Llama al proveedor de IA directamente desde el WebView con
 *   function-calling NATIVO (mismo runtime que server.ts).
 * - Shell ejecutada por ShellPlugin (ProcessBuilder → /system/bin/sh).
 * - Workspace en el storage privado: /data/data/com.novaclaw.app/files/workspace/
 * - Sesiones persistidas en localStorage (sobreviven reinicios de la app).
 * - BYOK: la API key la trae el usuario y vive SOLO en el Android Keystore
 *   (SecureKeyPlugin). No hay ninguna key embebida en el binario.
 */

import { createAgentSession } from './agent/runtime';
import type { AgentRuntimeEvent, AgentSession } from './agent/runtime';
import { createNativeAgentRuntime } from './agent/nativeAgent';
import { PROVIDERS, getProvider } from './agent/providers';
import { verifyAndListModels } from './agent/modelClient';
import { createWebViewToolExecutor } from './agent/toolsWebView';
import { createBootstrapStatus, type BootstrapStatus } from './bootstrap/state';

// ── Tipos compartidos ─────────────────────────────────────────────────────────

type ChatEvent =
 | { type: 'message'; message: string }
 | { type: 'toolExecution'; toolExecution: { name: string; command: string; status: 'success' | 'error'; output?: string } }
 | { type: 'approval'; approval: { summary: string; reason: string; toolCall: { tool: string; arguments: Record<string, unknown> } } };

type ChatResponse = { events: ChatEvent[] };
type TerminalResult = { output: string; cwd: string };

export type SessionHistoryEntry = { role: 'user' | 'assistant' | 'system'; content: string };
export type PendingApprovalSnapshot = { summary: string; reason: string; toolCall: { tool: string; arguments: Record<string, unknown> } } | null;
type ChatHistoryResponse = { history: SessionHistoryEntry[]; pendingApproval: PendingApprovalSnapshot };

export type ProviderConfig = { provider: string; baseUrl: string; model: string; hasApiKey: boolean; mode: 'remote' | 'local' };
export type ProviderConfigUpdate = { provider?: string; baseUrl?: string; model?: string; apiKey?: string };
export type ProviderInfo = { id: string; label: string; needsKey: boolean; keyHint: string; note: string | null };
export type ModelInfo = { id: string; label: string; tier?: 'premium' | 'value' };
export type VerifyResult = { ok: boolean; models: ModelInfo[]; error?: string };

type RuntimeSnapshot = {
 agent: { status: 'stopped' | 'running'; mode: 'remote' | 'local'; label: string };
 opencode: { status: 'stopped' | 'installing' | 'running'; installed: boolean; available: boolean; version: string | null; commandPath: string | null; message: string; lastExitCode: number | null };
 terminal: { status: 'ready'; cwd: string };
};

interface PlatformAdapter {
 readonly kind: 'web' | 'capacitor';
 getRuntimeStatus(): Promise<RuntimeSnapshot>;
 getBootstrapStatus(): Promise<BootstrapStatus>;
 installRuntime(): Promise<void>;
 subscribeBootstrap(listener: (status: BootstrapStatus) => void): () => void;
 startAgent(): Promise<void>;
 sendChat(message: string, sessionId: string): Promise<ChatResponse>;
 approveAction(sessionId: string, approved: boolean): Promise<ChatResponse>;
 /** Como sendChat pero entrega cada evento EN VIVO vía onEvent (streaming).
  * Si el streaming no está disponible, cae a sendChat y emite igual por onEvent. */
 sendChatStream(message: string, sessionId: string, onEvent: (ev: ChatEvent) => void): Promise<ChatResponse>;
 approveActionStream(sessionId: string, approved: boolean, onEvent: (ev: ChatEvent) => void): Promise<ChatResponse>;
 getChatHistory(sessionId: string): Promise<ChatHistoryResponse>;
 resetChat(sessionId: string): Promise<void>;
 runTerminal(command: string, cwd?: string): Promise<TerminalResult>;
 getLogs(): Promise<string[]>;
 clearLogs(): Promise<void>;
 startOpenCode(): Promise<void>;
 stopOpenCode(): Promise<void>;
 saveApiKey(key: string): Promise<void>;
 hasApiKey(): Promise<boolean>;
 getConfig(): Promise<ProviderConfig>;
 saveConfig(update: ProviderConfigUpdate): Promise<ProviderConfig>;
 getProviders(): Promise<{ providers: ProviderInfo[]; current: string }>;
 verifyProvider(provider: string, apiKey: string): Promise<VerifyResult>;
}

// ── Detección de Capacitor ────────────────────────────────────────────────────

declare global {
 interface Window {
 Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, unknown> };
 }
}

function isCapacitor(): boolean {
 return typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
}

// ── SSE (streaming de eventos del agente) ─────────────────────────────────────

/** Consume una respuesta SSE del server y emite cada evento `agent` al vuelo. */
async function consumeSse(res: Response, onEvent: (ev: ChatEvent) => void): Promise<ChatEvent[]> {
 const all: ChatEvent[] = [];
 const reader = res.body!.getReader();
 const decoder = new TextDecoder();
 let buffer = '';
 for (;;) {
 const { done, value } = await reader.read();
 if (done) break;
 buffer += decoder.decode(value, { stream: true });
 let sep = buffer.indexOf('\n\n');
 while (sep !== -1) {
 const chunk = buffer.slice(0, sep);
 buffer = buffer.slice(sep + 2);
 let eventName = 'message';
 let dataLine = '';
 for (const line of chunk.split('\n')) {
 if (line.startsWith('event: ')) eventName = line.slice(7).trim();
 else if (line.startsWith('data: ')) dataLine += line.slice(6);
 }
 if (eventName === 'agent' && dataLine) {
 try {
 const ev = JSON.parse(dataLine) as ChatEvent;
 all.push(ev);
 onEvent(ev);
 } catch { /* evento malformado — se ignora */ }
 }
 sep = buffer.indexOf('\n\n');
 }
 }
 return all;
}

// ── Web adapter ───────────────────────────────────────────────────────────────

const webAdapter: PlatformAdapter = {
 kind: 'web',
 async getRuntimeStatus() { const r = await fetch('/api/runtime/status'); return r.json(); },
 async getBootstrapStatus() { return createBootstrapStatus({ phase: 'ready', message: 'Browser prototype ready.' }); },
 async installRuntime() {},
 subscribeBootstrap(listener) { listener(createBootstrapStatus({ phase: 'ready', message: 'Browser prototype ready.' })); return () => {}; },
 async startAgent() { await fetch('/api/agent/start', { method: 'POST' }); },
 async sendChat(message, sessionId) {
 const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, sessionId }) });
 return r.json();
 },
 async approveAction(sessionId, approved) {
 const r = await fetch('/api/chat/approval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, approved }) });
 return r.json();
 },
 async sendChatStream(message, sessionId, onEvent) {
 try {
 const r = await fetch('/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, sessionId }) });
 if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
 const events = await consumeSse(r, onEvent);
 return { events };
 } catch {
 // Fallback sin streaming: emitimos los eventos al final por el mismo camino.
 const data = await webAdapter.sendChat(message, sessionId);
 for (const ev of data.events ?? []) onEvent(ev);
 return data;
 }
 },
 async approveActionStream(sessionId, approved, onEvent) {
 try {
 const r = await fetch('/api/chat/approval/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, approved }) });
 if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
 const events = await consumeSse(r, onEvent);
 return { events };
 } catch {
 const data = await webAdapter.approveAction(sessionId, approved);
 for (const ev of data.events ?? []) onEvent(ev);
 return data;
 }
 },
 async getChatHistory(sessionId) {
 const r = await fetch(`/api/chat/history?sessionId=${encodeURIComponent(sessionId)}`);
 return r.json();
 },
 async resetChat(sessionId) {
 await fetch('/api/chat/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) });
 },
 async runTerminal(command, cwd) {
 const r = await fetch('/api/terminal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, cwd }) });
 return r.json();
 },
 async getLogs() { const r = await fetch('/api/logs'); const d = await r.json(); return d.logs ?? []; },
 async clearLogs() { await fetch('/api/logs', { method: 'DELETE' }); },
 async startOpenCode() { await fetch('/api/opencode/start', { method: 'POST' }); },
 async stopOpenCode() { await fetch('/api/opencode/stop', { method: 'POST' }); },
 async saveApiKey(_key) {},
 async hasApiKey() { return false; },
 async getConfig() { const r = await fetch('/api/config'); return r.json(); },
 async saveConfig(update) {
 const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update) });
 if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error ?? 'No se pudo guardar la configuración.'); }
 return r.json();
 },
 async getProviders() { const r = await fetch('/api/providers'); return r.json(); },
 async verifyProvider(provider, apiKey) {
 const r = await fetch('/api/provider/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, apiKey }) });
 return r.json();
 },
};

// ── Constantes Capacitor ──────────────────────────────────────────────────────

const APP_FILES = '/data/data/com.novaclaw.app/files';
const WORKSPACE = `${APP_FILES}/workspace`;

const SESSION_STORAGE_KEY = 'novaclaw_sessions_v3';
const PROVIDER_CONFIG_KEY = 'novaclaw_provider_config_v1';

// Config de proveedor/modelo (la key NO va acá: vive en el Keystore).
type CapProviderConfig = { provider: string; model: string };

const DEFAULT_CAP_CONFIG: CapProviderConfig = { provider: 'opencode-zen', model: 'claude-haiku-4-5' };

function loadProviderConfig(): CapProviderConfig {
 try {
 const raw = localStorage.getItem(PROVIDER_CONFIG_KEY);
 if (!raw) return { ...DEFAULT_CAP_CONFIG };
 const parsed = JSON.parse(raw);
 return {
 provider: typeof parsed.provider === 'string' && getProvider(parsed.provider) ? parsed.provider : DEFAULT_CAP_CONFIG.provider,
 model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model : DEFAULT_CAP_CONFIG.model,
 };
 } catch { return { ...DEFAULT_CAP_CONFIG }; }
}

function saveProviderConfig(cfg: CapProviderConfig): void {
 try { localStorage.setItem(PROVIDER_CONFIG_KEY, JSON.stringify(cfg)); } catch {}
}

// ── Persistencia de sesiones ──────────────────────────────────────────────────

type PersistedSession = {
 id: string; cwd: string;
 history: AgentSession['history'];
 pendingApproval: AgentSession['pendingApproval'];
};

function persistSessions(sessions: Map<string, AgentSession>): void {
 try {
 const obj: Record<string, PersistedSession> = {};
 for (const [k, s] of sessions)
 obj[k] = { id: s.id, cwd: s.cwd, history: s.history, pendingApproval: s.pendingApproval };
 localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(obj));
 } catch {}
}

function loadPersistedSessions(): Map<string, AgentSession> {
 const map = new Map<string, AgentSession>();
 try {
 const raw = localStorage.getItem(SESSION_STORAGE_KEY);
 if (!raw) return map;
 const parsed = JSON.parse(raw) as Record<string, PersistedSession>;
 for (const [k, s] of Object.entries(parsed))
 map.set(k, { id: s.id ?? k, workspaceRoot: WORKSPACE, cwd: s.cwd ?? WORKSPACE, history: Array.isArray(s.history) ? s.history : [], pendingApproval: s.pendingApproval ?? null });
 } catch { localStorage.removeItem(SESSION_STORAGE_KEY); }
 return map;
}

const capacitorSessions = loadPersistedSessions();

function createNewSession(id: string): AgentSession {
 const s = createAgentSession(id, WORKSPACE);
 capacitorSessions.set(id, s);
 persistSessions(capacitorSessions);
 return s;
}

// ── API key (BYOK: solo Android Keystore, nunca embebida) ────────────────────

async function resolveApiKey(): Promise<string> {
 const Plugins: any = window.Capacitor?.Plugins ?? {};
 if (Plugins.SecureKey) {
 try { const { has } = await Plugins.SecureKey.has(); if (has) { const { value } = await Plugins.SecureKey.get(); if (value) return value as string; } } catch {}
 }
 return '';
}

async function saveApiKeyNative(key: string): Promise<void> {
 const Plugins: any = window.Capacitor?.Plugins ?? {};
 if (Plugins.SecureKey) { try { await Plugins.SecureKey.store({ value: key }); return; } catch {} }
 // No localStorage fallback — key must go through Android Keystore
}

async function hasApiKeyNative(): Promise<boolean> {
 const Plugins: any = window.Capacitor?.Plugins ?? {};
 if (Plugins.SecureKey) { try { const { has } = await Plugins.SecureKey.has(); if (has) return true; } catch {} }
 return false;
}

// ── Runtime del agente (function-calling nativo, igual que server.ts) ────────

function runtimeEventToChatEvent(ev: AgentRuntimeEvent): ChatEvent {
 if (ev.type === 'message') return { type: 'message', message: ev.message };
 if (ev.type === 'toolExecution')
 return { type: 'toolExecution', toolExecution: { name: ev.toolExecution.name, command: ev.toolExecution.command, status: ev.toolExecution.status, output: ev.toolExecution.output } };
 return { type: 'approval', approval: { summary: ev.approval.summary, reason: ev.approval.reason, toolCall: { tool: ev.approval.toolCall.tool, arguments: ev.approval.toolCall.arguments } } };
}

const NO_KEY_MESSAGE = '⚠️ No hay API key configurada. Ve a **Ajustes → Proveedor de IA** e introduce tu propia clave (OpenRouter, Zen, NVIDIA…) para activar el agente.';

/** Crea el runtime nativo con la config actual (key del Keystore + proveedor/modelo de localStorage). */
function buildCapacitorRuntime(apiKey: string) {
 const cfg = loadProviderConfig();
 return createNativeAgentRuntime({
 workspaceRoot: WORKSPACE,
 getConfig: () => ({ providerId: cfg.provider, apiKey, model: cfg.model }),
 executeToolCall: sharedToolExecutor,
 });
}

// ── Bootstrap state ───────────────────────────────────────────────────────────

const bootstrapListeners = new Set<(s: BootstrapStatus) => void>();
let bootstrapStatus = createBootstrapStatus({ phase: 'checking', message: 'Verificando entorno...' });

function emitBootstrap(s: BootstrapStatus) {
 bootstrapStatus = s;
 for (const l of bootstrapListeners) l(s);
}

// ── Tool executor (singleton) ─────────────────────────────────────────────────

const sharedToolExecutor = createWebViewToolExecutor();

// ── Capacitor adapter ─────────────────────────────────────────────────────────

const capacitorAdapter: PlatformAdapter = {
 kind: 'capacitor',

 async getRuntimeStatus(): Promise<RuntimeSnapshot> {
 const Plugins: any = window.Capacitor?.Plugins ?? {};
 const [shellReady, installerCheck] = await Promise.all([
 Plugins.Shell?.isReady?.() ?? { ready: false },
 Plugins.RuntimeInstaller?.checkInstalled?.() ?? { installed: false },
 ]);
 const hasKey = await hasApiKeyNative();
 return {
 agent: {
 status: 'running',
 mode: 'local',
 label: hasKey
 ? (shellReady.ready ? 'Agente listo ✓' : 'Primer arranque — presiona Iniciar')
 : '⚠️ Sin API key — ve a Ajustes',
 },
 opencode: {
 status: installerCheck.installed ? 'stopped' : 'stopped',
 installed: !!installerCheck.installed,
 available: true,
 version: null,
 commandPath: installerCheck.workspaceRoot || null,
 message: installerCheck.installed
 ? `Workspace listo en ${installerCheck.workspaceRoot}`
 : 'Presiona "Iniciar Agente" para el primer arranque.',
 lastExitCode: null,
 },
 terminal: { status: 'ready', cwd: shellReady.workspaceRoot ?? WORKSPACE },
 };
 },

 async getBootstrapStatus(): Promise<BootstrapStatus> {
 const Plugins: any = window.Capacitor?.Plugins ?? {};
 const [shellReady, installerCheck] = await Promise.all([
 Plugins.Shell?.isReady?.() ?? { ready: false },
 Plugins.RuntimeInstaller?.checkInstalled?.() ?? { installed: false },
 ]);

 if (installerCheck.installed && shellReady.ready) {
 const s = createBootstrapStatus({ phase: 'ready', message: 'Entorno listo.' });
 emitBootstrap(s);
 return s;
 }

 if (bootstrapStatus.phase === 'checking') {
 const s = createBootstrapStatus({ phase: 'not_installed', message: 'Primer arranque — configura el workspace.' });
 emitBootstrap(s);
 return s;
 }

 return bootstrapStatus;
 },

 async installRuntime(): Promise<void> {
 const Plugins: any = window.Capacitor?.Plugins ?? {};
 const installer = Plugins.RuntimeInstaller;

 if (!installer?.install) {
 emitBootstrap(createBootstrapStatus({ phase: 'error', message: 'Plugin de instalación no disponible.', error: 'RuntimeInstaller plugin missing' }));
 return;
 }

 emitBootstrap(createBootstrapStatus({ phase: 'installing', message: 'Configurando workspace...', progress: 0 }));

 const progressHandle = installer.addListener?.('progress', (ev: any) => {
 const step = typeof ev?.step === 'number' ? ev.step : 0;
 const total = typeof ev?.total === 'number' ? ev.total : 5;
 emitBootstrap(createBootstrapStatus({ phase: 'installing', message: ev?.label ?? 'Configurando...', progress: (step / total) * 100 }));
 });

 const doneHandle = installer.addListener?.('done', async (ev: any) => {
 if (ev?.success) {
 emitBootstrap(createBootstrapStatus({ phase: 'ready', message: 'Entorno listo ✓' }));
 } else {
 emitBootstrap(createBootstrapStatus({ phase: 'error', message: ev?.failedStep ? `Falló en: ${ev.failedStep}` : 'Error en la configuración.', error: ev?.output ?? null }));
 }
 await progressHandle?.remove?.();
 await doneHandle?.remove?.();
 });

 try {
 await installer.install();
 } catch (error: any) {
 emitBootstrap(createBootstrapStatus({ phase: 'error', message: 'Error en la configuración.', error: error?.message ?? String(error) }));
 await progressHandle?.remove?.();
 await doneHandle?.remove?.();
 }
 },

 subscribeBootstrap(listener) {
 bootstrapListeners.add(listener);
 listener(bootstrapStatus);
 return () => { bootstrapListeners.delete(listener); };
 },

 async startAgent(): Promise<void> {
 const Plugins: any = window.Capacitor?.Plugins ?? {};
 const check = await Plugins.RuntimeInstaller?.checkInstalled?.() ?? { installed: false };
 if (!check.installed) {
 await capacitorAdapter.installRuntime();
 }
 },

 async sendChat(message: string, sessionId: string): Promise<ChatResponse> {
 const session = capacitorSessions.get(sessionId) ?? createNewSession(sessionId);
 const apiKey = await resolveApiKey();
 if (!apiKey) return { events: [{ type: 'message', message: NO_KEY_MESSAGE }] };
 const runtime = buildCapacitorRuntime(apiKey);
 const result = await runtime.runUserTurn(session, message);
 capacitorSessions.set(sessionId, session);
 persistSessions(capacitorSessions);
 return { events: result.events.map(runtimeEventToChatEvent) };
 },

 async approveAction(sessionId: string, approved: boolean): Promise<ChatResponse> {
 const session = capacitorSessions.get(sessionId);
 if (!session) return { events: [{ type: 'message', message: 'Sesión no encontrada.' }] };
 const apiKey = await resolveApiKey();
 if (!apiKey) return { events: [{ type: 'message', message: NO_KEY_MESSAGE }] };
 const runtime = buildCapacitorRuntime(apiKey);
 const result = await runtime.resolveApproval(session, approved);
 capacitorSessions.set(sessionId, session);
 persistSessions(capacitorSessions);
 return { events: result.events.map(runtimeEventToChatEvent) };
 },

 // El runtime vive en el mismo proceso: streaming = pasar el sink directo.
 async sendChatStream(message, sessionId, onEvent) {
 const session = capacitorSessions.get(sessionId) ?? createNewSession(sessionId);
 const apiKey = await resolveApiKey();
 if (!apiKey) {
 const ev: ChatEvent = { type: 'message', message: NO_KEY_MESSAGE };
 onEvent(ev);
 return { events: [ev] };
 }
 const runtime = buildCapacitorRuntime(apiKey);
 const result = await runtime.runUserTurn(session, message, (ev) => onEvent(runtimeEventToChatEvent(ev)));
 capacitorSessions.set(sessionId, session);
 persistSessions(capacitorSessions);
 return { events: result.events.map(runtimeEventToChatEvent) };
 },
 async approveActionStream(sessionId, approved, onEvent) {
 const session = capacitorSessions.get(sessionId);
 if (!session) {
 const ev: ChatEvent = { type: 'message', message: 'Sesión no encontrada.' };
 onEvent(ev);
 return { events: [ev] };
 }
 const apiKey = await resolveApiKey();
 if (!apiKey) {
 const ev: ChatEvent = { type: 'message', message: NO_KEY_MESSAGE };
 onEvent(ev);
 return { events: [ev] };
 }
 const runtime = buildCapacitorRuntime(apiKey);
 const result = await runtime.resolveApproval(session, approved, (ev) => onEvent(runtimeEventToChatEvent(ev)));
 capacitorSessions.set(sessionId, session);
 persistSessions(capacitorSessions);
 return { events: result.events.map(runtimeEventToChatEvent) };
 },

 async getChatHistory(sessionId: string): Promise<ChatHistoryResponse> {
 const session = capacitorSessions.get(sessionId);
 if (!session) return { history: [], pendingApproval: null };
 return {
 history: session.history,
 pendingApproval: session.pendingApproval
 ? { summary: session.pendingApproval.summary, reason: session.pendingApproval.reason, toolCall: { tool: session.pendingApproval.toolCall.tool, arguments: session.pendingApproval.toolCall.arguments } }
 : null,
 };
 },

 async resetChat(sessionId: string): Promise<void> {
 capacitorSessions.delete(sessionId);
 persistSessions(capacitorSessions);
 },

 async runTerminal(command: string, cwd?: string): Promise<TerminalResult> {
 const Plugins: any = window.Capacitor?.Plugins ?? {};
 if (!Plugins.Shell) return { output: 'ShellPlugin no disponible.', cwd: cwd ?? WORKSPACE };
 const res = await Plugins.Shell.run({ command, cwd: cwd ?? WORKSPACE });
 return { output: res.output ?? '', cwd: res.cwd ?? (cwd ?? WORKSPACE) };
 },

 async getLogs(): Promise<string[]> { return []; },
 async clearLogs(): Promise<void> {},

 async startOpenCode(): Promise<void> { await capacitorAdapter.installRuntime(); },
 async stopOpenCode(): Promise<void> {},

 async saveApiKey(key: string): Promise<void> { await saveApiKeyNative(key); },
 async hasApiKey(): Promise<boolean> { return hasApiKeyNative(); },

 // En Capacitor la key vive en el Keystore y proveedor/modelo en localStorage.
 async getConfig(): Promise<ProviderConfig> {
 const cfg = loadProviderConfig();
 const provider = getProvider(cfg.provider);
 const hasKey = await hasApiKeyNative();
 return { provider: cfg.provider, baseUrl: provider?.baseUrl ?? '', model: cfg.model, hasApiKey: hasKey, mode: hasKey ? 'remote' : 'local' };
 },
 async saveConfig(update: ProviderConfigUpdate): Promise<ProviderConfig> {
 const cfg = loadProviderConfig();
 if (typeof update.provider === 'string' && update.provider.trim() && getProvider(update.provider.trim())) cfg.provider = update.provider.trim();
 if (typeof update.model === 'string' && update.model.trim()) cfg.model = update.model.trim();
 saveProviderConfig(cfg);
 if (typeof update.apiKey === 'string') await saveApiKeyNative(update.apiKey);
 return capacitorAdapter.getConfig();
 },
 async getProviders() {
 const cfg = loadProviderConfig();
 return {
 providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label, needsKey: p.needsKey, keyHint: p.keyHint, note: p.note ?? null })),
 current: cfg.provider,
 };
 },
 async verifyProvider(provider: string, apiKey: string) {
 const key = apiKey?.trim() ? apiKey.trim() : await resolveApiKey();
 return verifyAndListModels(provider, key);
 },
};

// ── Export ────────────────────────────────────────────────────────────────────

export const platform: PlatformAdapter = isCapacitor() ? capacitorAdapter : webAdapter;
export type { PlatformAdapter, RuntimeSnapshot, ChatEvent, ChatResponse, ChatHistoryResponse, TerminalResult };
