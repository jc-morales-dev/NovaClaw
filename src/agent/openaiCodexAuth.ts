/**
 * openaiCodexAuth.ts — Login con cuenta ChatGPT (OpenAI Codex) sin API key.
 *
 * Implementa el flujo de código de dispositivo de OpenAI (el de `codex login
 * --device-auth`, replicado del código abierto de openai/codex): perfecto para
 * el teléfono porque no exige levantar un servidor de callback ni interceptar
 * redirects — el usuario abre una página, escribe un código corto y listo.
 *
 * NO es el device flow estándar RFC 8628: los endpoints y el shape son propios
 * de OpenAI (deviceauth/usercode + deviceauth/token devuelven un authorization
 * code con PKCE generado por el servidor, que luego se cambia por tokens en
 * /oauth/token).
 *
 * Los tokens (access + refresh + account_id) viven en un archivo dentro del
 * HOME del Linux embebido — el sandbox privado de la app, mismo nivel de
 * protección que el resto de la config. El access token dura ~horas y se
 * refresca solo; el refresh token dura semanas.
 */
import fs from 'node:fs';
import path from 'node:path';

const ISSUER = 'https://auth.openai.com';
// Client ID PÚBLICO del CLI oficial de Codex (openai/codex, login/src/auth/manager.rs).
// No es un secreto: identifica a la app OAuth, la identidad la pone el usuario al loguearse.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_FILE = path.join(process.env.HOME || process.cwd(), '.novaclaw-openai-auth.json');
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Header ChatGPT-Account-Id que exige el backend (sale del id_token). */
  accountId?: string;
  /** Epoch ms del último refresh/login (informativo). */
  lastRefresh?: number;
}

export type CodexDeviceStart = {
  deviceAuthId: string;
  userCode: string;
  /** Página donde el usuario escribe el código: https://auth.openai.com/codex/device */
  verificationUri: string;
  interval: number;
};

export type CodexDevicePoll =
  | { status: 'pending' }
  | { status: 'authorized'; accountId?: string }
  | { status: 'error'; error: string };

// ── Storage ──────────────────────────────────────────────────────────────────

export function loadCodexTokens(): CodexTokens | null {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (typeof raw?.accessToken === 'string' && typeof raw?.refreshToken === 'string') {
      return raw as CodexTokens;
    }
  } catch { /* sin login todavía */ }
  return null;
}

function saveCodexTokens(tokens: CodexTokens): void {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(tokens, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export function clearCodexTokens(): void {
  try { fs.unlinkSync(AUTH_FILE); } catch { /* ya no estaba */ }
}

export function hasCodexAuth(): boolean {
  return loadCodexTokens() !== null;
}

// ── JWT helpers (sin verificar firma: solo leemos claims de NUESTRO token) ──

function jwtPayload(token: string): any | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch { return null; }
}

function accountIdFromIdToken(idToken: string): string | undefined {
  const auth = jwtPayload(idToken)?.['https://api.openai.com/auth'];
  const id = auth?.chatgpt_account_id;
  return typeof id === 'string' && id ? id : undefined;
}

/** Plan de la cuenta (free/plus/pro/team…), para mostrarlo en Ajustes. */
export function codexPlanType(): string | undefined {
  const t = loadCodexTokens();
  if (!t?.idToken) return undefined;
  const plan = jwtPayload(t.idToken)?.['https://api.openai.com/auth']?.chatgpt_plan_type;
  return typeof plan === 'string' && plan ? plan : undefined;
}

// ── Device flow ──────────────────────────────────────────────────────────────

/** Paso 1: pedir el código corto que el usuario escribe en la página de OpenAI. */
export async function startCodexDeviceFlow(): Promise<CodexDeviceStart> {
  const res = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`OpenAI no aceptó el inicio del login (HTTP ${res.status}). Probá de nuevo en un rato.`);
  }
  const d = await res.json();
  if (!d?.device_auth_id || !d?.user_code) {
    throw new Error('Respuesta de OpenAI sin device_auth_id/user_code.');
  }
  return {
    deviceAuthId: String(d.device_auth_id),
    userCode: String(d.user_code),
    verificationUri: `${ISSUER}/codex/device`,
    interval: Number(d.interval) || 5,
  };
}

/**
 * Paso 2 (una vez por poll): ¿el usuario ya puso el código y autorizó?
 * 403/404 = todavía no. 200 = OpenAI devuelve un authorization code + el par
 * PKCE generado por SU servidor; acá mismo lo cambiamos por los tokens y los
 * guardamos. La UI llama esto en loop cada `interval` segundos.
 */
export async function pollCodexDeviceFlow(flow: CodexDeviceStart): Promise<CodexDevicePoll> {
  let res: Response;
  try {
    res = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ device_auth_id: flow.deviceAuthId, user_code: flow.userCode }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e: any) {
    return { status: 'error', error: e?.message ?? 'error de red' };
  }
  if (res.status === 403 || res.status === 404) return { status: 'pending' };
  if (!res.ok) return { status: 'error', error: `deviceauth/token respondió ${res.status}` };

  const d = await res.json().catch(() => null);
  if (!d?.authorization_code || !d?.code_verifier) {
    return { status: 'error', error: 'respuesta de autorización incompleta' };
  }

  // Intercambio del code por tokens (con el PKCE que generó el server de OpenAI).
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(d.authorization_code),
    redirect_uri: `${ISSUER}/deviceauth/callback`,
    client_id: CLIENT_ID,
    code_verifier: String(d.code_verifier),
  });
  const tokenRes = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  });
  if (!tokenRes.ok) {
    return { status: 'error', error: `el intercambio de tokens falló (HTTP ${tokenRes.status})` };
  }
  const tokens = await tokenRes.json();
  if (!tokens?.access_token || !tokens?.refresh_token) {
    return { status: 'error', error: 'OpenAI no devolvió los tokens esperados' };
  }
  const accountId = tokens.id_token ? accountIdFromIdToken(String(tokens.id_token)) : undefined;
  saveCodexTokens({
    accessToken: String(tokens.access_token),
    refreshToken: String(tokens.refresh_token),
    idToken: tokens.id_token ? String(tokens.id_token) : undefined,
    accountId,
    lastRefresh: Date.now(),
  });
  return { status: 'authorized', accountId };
}

// ── Refresh + acceso ─────────────────────────────────────────────────────────

let refreshing: Promise<CodexTokens> | null = null;

async function refreshCodexTokens(current: CodexTokens): Promise<CodexTokens> {
  // Single-flight: en el loop agéntico varias llamadas pueden ver el token
  // vencido a la vez; refrescar dos veces invalida el refresh token (rotación).
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const res = await fetch(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          client_id: CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: current.refreshToken,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // Refresh token vencido/rotado/revocado → hay que loguearse de nuevo.
        if (res.status === 400 || res.status === 401) {
          clearCodexTokens();
          throw new Error('La sesión de ChatGPT venció. Volvé a iniciar sesión en Ajustes → Proveedor de IA.');
        }
        throw new Error(`No se pudo refrescar la sesión de ChatGPT (HTTP ${res.status}): ${text.slice(0, 160)}`);
      }
      const d = await res.json();
      const next: CodexTokens = {
        accessToken: d.access_token ? String(d.access_token) : current.accessToken,
        refreshToken: d.refresh_token ? String(d.refresh_token) : current.refreshToken,
        idToken: d.id_token ? String(d.id_token) : current.idToken,
        accountId: d.id_token ? (accountIdFromIdToken(String(d.id_token)) ?? current.accountId) : current.accountId,
        lastRefresh: Date.now(),
      };
      saveCodexTokens(next);
      return next;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * Access token listo para usar: si está por vencer (o `force`), se refresca y
 * persiste solo. Lanza con mensaje claro si no hay sesión o si venció del todo.
 */
export async function getCodexAccess(force = false): Promise<{ accessToken: string; accountId?: string }> {
  let tokens = loadCodexTokens();
  if (!tokens) {
    throw new Error('No hay sesión de ChatGPT. Iniciá sesión en Ajustes → Proveedor de IA → OpenAI Codex.');
  }
  const exp = jwtPayload(tokens.accessToken)?.exp;
  const expiresSoon = typeof exp === 'number' && exp * 1000 < Date.now() + 120_000;
  if (force || expiresSoon) {
    tokens = await refreshCodexTokens(tokens);
  }
  return { accessToken: tokens.accessToken, accountId: tokens.accountId };
}
