/**
 * platform.ts — Capa de abstracción para Web y Android APK.
 *
 * Modo Web: fetch() contra el servidor Express local (server.ts).
 * Modo Android (Capacitor):
 * - Llama a la Zen API directamente desde el WebView.
 * - Shell ejecutada por ShellPlugin (ProcessBuilder → /system/bin/sh).
 * - Workspace en el storage privado: /data/data/com.novaclaw.app/files/workspace/
 * - Sesiones persistidas en localStorage (sobreviven reinicios de la app).
 * - API key guardada en Android Keystore vía SecureKeyPlugin.
 */

import { createAgentRuntime, createAgentSession } from './agent/runtime';
import type { AgentRuntimeEvent, AgentSession } from './agent/runtime';
import { getEmbeddedZenKey } from './agent/embeddedKey';
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

export type ProviderConfig = { baseUrl: string; model: string; hasApiKey: boolean; mode: 'remote' | 'local' };
export type ProviderConfigUpdate = { baseUrl?: string; model?: string; apiKey?: string };

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
};

// ── Constantes Capacitor ──────────────────────────────────────────────────────

const ZEN_API_URL = 'https://opencode.ai/zen/v1/chat/completions';
const ZEN_MODEL = 'minimax-m2.5-free';
const APP_FILES = '/data/data/com.novaclaw.app/files';
const WORKSPACE = `${APP_FILES}/workspace`;

const SESSION_STORAGE_KEY = 'novaclaw_sessions_v3';

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

// ── API key ───────────────────────────────────────────────────────────────────

async function resolveApiKey(): Promise<string> {
 const Plugins: any = window.Capacitor?.Plugins ?? {};
 if (Plugins.SecureKey) {
 try { const { has } = await Plugins.SecureKey.has(); if (has) { const { value } = await Plugins.SecureKey.get(); if (value) return value as string; } } catch {}
 }
 const embedded = getEmbeddedZenKey();
 if (embedded) return embedded;
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
 return !!getEmbeddedZenKey();
}

// ── Zen API ───────────────────────────────────────────────────────────────────

function runtimeEventToChatEvent(ev: AgentRuntimeEvent): ChatEvent {
 if (ev.type === 'message') return { type: 'message', message: ev.message };
 if (ev.type === 'toolExecution')
 return { type: 'toolExecution', toolExecution: { name: ev.toolExecution.name, command: ev.toolExecution.command, status: ev.toolExecution.status, output: ev.toolExecution.output } };
 return { type: 'approval', approval: { summary: ev.approval.summary, reason: ev.approval.reason, toolCall: { tool: ev.approval.toolCall.tool, arguments: ev.approval.toolCall.arguments } } };
}

async function callZen(
 input: { systemPrompt: string; messages: { role: 'user' | 'assistant' | 'system'; content: string }[]; cwd: string; workspaceRoot: string },
 apiKey: string,
): Promise<string> {
 if (!apiKey) {
 return JSON.stringify({
 kind: 'message',
 message: '⚠️ No hay API key configurada. Ve a **Ajustes → API Key** e introduce tu clave de opencode.ai para activar el agente.',
 });
 }
 const body = JSON.stringify({ model: ZEN_MODEL, messages: [{ role: 'system', content: input.systemPrompt }, ...input.messages], stream: false });
 const MAX_RETRIES = 2;
 const TIMEOUT_MS = 60_000;
 for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
 try {
 const res = await fetch(ZEN_API_URL, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
 body,
 signal: controller.signal,
 });
 clearTimeout(timer);
 if (!res.ok) {
 const t = await res.text();
 if (res.status >= 500 && attempt < MAX_RETRIES) continue;
 throw new Error(`Zen API ${res.status}: ${t.slice(0, 300)}`);
 }
 const data = await res.json();
 return data?.choices?.[0]?.message?.content ?? '';
 } catch (err: any) {
 clearTimeout(timer);
 if (err?.name === 'AbortError' && attempt < MAX_RETRIES) continue;
 throw err;
 }
 }
 return '';
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
 const runtime = createAgentRuntime({ workspaceRoot: WORKSPACE, callModel: (input) => callZen(input, apiKey), executeToolCall: sharedToolExecutor });
 const result = await runtime.runUserTurn(session, message);
 capacitorSessions.set(sessionId, session);
 persistSessions(capacitorSessions);
 return { events: result.events.map(runtimeEventToChatEvent) };
 },

 async approveAction(sessionId: string, approved: boolean): Promise<ChatResponse> {
 const session = capacitorSessions.get(sessionId);
 if (!session) return { events: [{ type: 'message', message: 'Sesión no encontrada.' }] };
 const apiKey = await resolveApiKey();
 const runtime = createAgentRuntime({ workspaceRoot: WORKSPACE, callModel: (input) => callZen(input, apiKey), executeToolCall: sharedToolExecutor });
 const result = await runtime.resolveApproval(session, approved);
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

 // En Capacitor la config vive en el Keystore/embedded; exponemos una vista compatible.
 async getConfig(): Promise<ProviderConfig> {
 return { baseUrl: ZEN_API_URL.replace('/chat/completions', ''), model: ZEN_MODEL, hasApiKey: await hasApiKeyNative(), mode: (await hasApiKeyNative()) ? 'remote' : 'local' };
 },
 async saveConfig(update: ProviderConfigUpdate): Promise<ProviderConfig> {
 if (typeof update.apiKey === 'string') await saveApiKeyNative(update.apiKey);
 return capacitorAdapter.getConfig();
 },
};

// ── Export ────────────────────────────────────────────────────────────────────

export const platform: PlatformAdapter = isCapacitor() ? capacitorAdapter : webAdapter;
export type { PlatformAdapter, RuntimeSnapshot, ChatEvent, ChatResponse, ChatHistoryResponse, TerminalResult };
