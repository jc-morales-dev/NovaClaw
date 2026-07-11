import fs from 'node:fs';
import path from 'node:path';

import { getProvider } from '../agent/providers';

// Configuración del proveedor de IA. Mutable en runtime para que la pantalla de
// Ajustes pueda cambiar baseUrl/apiKey/model SIN reiniciar el agente ni recompilar.
// Modelo BYOK: la key SIEMPRE la trae el usuario (Ajustes → novaclaw.config.json)
// o la env var en dev. Nunca se embebe una key en el binario distribuido.
//   1. ZEN_API_KEY env var (dev/CI; en Android la setea RuntimeManager desde el config)
//   2. novaclaw.config.json (lo que el usuario guardó desde Ajustes)
//   3. Vacío → arranca el fallback heurístico local
export const zenConfig = {
  provider: process.env.NOVACLAW_PROVIDER || 'opencode-zen',
  apiKey: process.env.ZEN_API_KEY || '',
  // minimax-m2.5-free fue discontinuado. Default a un modelo vigente y económico.
  baseUrl: process.env.ZEN_BASE_URL ?? 'https://opencode.ai/zen/v1',
  model: process.env.ZEN_MODEL ?? 'claude-haiku-4-5',
};

// Token compartido app↔agente. Lo genera la capa nativa (Kotlin, TokenStore) y lo
// pasa por env NOVACLAW_TOKEN. En dev (PC) queda vacío y NO se exige. Protege
// /api/* y /pty de que OTRA app del teléfono le hable al agente por loopback.
export const AGENT_TOKEN = process.env.NOVACLAW_TOKEN || '';

export const DEFAULT_CWD = process.cwd();

// Archivo persistente de config (fuera de git). RuntimeManager lo lee al arrancar;
// acá lo escribimos cuando el usuario guarda desde Ajustes, así sobrevive reinicios.
export const NOVACLAW_CONFIG_PATH = process.env.NOVACLAW_CONFIG
  || path.join(process.env.HOME || DEFAULT_CWD, '..', 'novaclaw.config.json');

export const AGENT_SESSION_ID = 'nova-chat-session';

/** Mantiene baseUrl coherente con el proveedor elegido. */
export function syncBaseUrlToProvider() {
  const provider = getProvider(zenConfig.provider);
  if (provider) zenConfig.baseUrl = provider.baseUrl;
}

/** Lee novaclaw.config.json (si existe) y lo mergea sobre zenConfig. */
export function loadConfigFromFile() {
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

/** Persiste zenConfig a novaclaw.config.json (para que sobreviva reinicios del agente).
 *  La API KEY ya NO se guarda en texto plano acá: en Android vive cifrada en el
 *  Android Keystore (RuntimeManager la inyecta por env al arrancar). Solo se
 *  persisten proveedor/baseUrl/modelo, que no son secretos. */
export function saveConfigToFile() {
  try {
    fs.writeFileSync(
      NOVACLAW_CONFIG_PATH,
      JSON.stringify({ provider: zenConfig.provider, baseUrl: zenConfig.baseUrl, apiKey: '', model: zenConfig.model }, null, 2),
      'utf8',
    );
  } catch (error: any) {
    console.error('No se pudo guardar novaclaw.config.json:', error?.message);
    throw error;
  }
}
