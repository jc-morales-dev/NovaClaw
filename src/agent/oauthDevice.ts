/**
 * oauthDevice.ts — OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * Es el "flujo del código": el proveedor da un código corto + una URL; el
 * usuario abre la URL, pone el código y autoriza (ahí va su login/huella DEL
 * SERVICIO). Nosotros hacemos polling hasta recibir el token y lo guardamos
 * cifrado. Perfecto para el teléfono: no hay que registrar redirect URIs ni
 * abrir un navegador embebido con callback.
 */

export type DeviceAuthSpec = {
  deviceAuthUrl: string;
  tokenUrl: string;
  clientId: string;
  scope?: string;
};

export type DeviceStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  interval: number;   // segundos entre polls
  expiresIn: number;  // segundos hasta que el código vence
};

export type DevicePoll =
  | { status: 'pending'; interval?: number }
  | { status: 'authorized'; token: string }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'error'; error: string };

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };

/** Paso 1: pedir el device_code + user_code al proveedor. */
export async function startDeviceFlow(spec: DeviceAuthSpec): Promise<DeviceStart> {
  const body = new URLSearchParams({ client_id: spec.clientId });
  if (spec.scope) body.set('scope', spec.scope);
  const res = await fetch(spec.deviceAuthUrl, {
    method: 'POST',
    headers: FORM,
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`device authorization failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const d = await res.json();
  if (!d?.device_code || !d?.user_code) {
    throw new Error('respuesta de device authorization sin device_code/user_code');
  }
  return {
    deviceCode: String(d.device_code),
    userCode: String(d.user_code),
    verificationUri: String(d.verification_uri ?? d.verification_url ?? ''),
    verificationUriComplete: d.verification_uri_complete ? String(d.verification_uri_complete) : undefined,
    interval: Number(d.interval) || 5,
    expiresIn: Number(d.expires_in) || 900,
  };
}

/** Paso 2 (una vez): consultar si el usuario ya autorizó. La UI llama en loop. */
export async function pollDeviceToken(spec: DeviceAuthSpec, deviceCode: string): Promise<DevicePoll> {
  const body = new URLSearchParams({
    client_id: spec.clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  let d: any;
  try {
    const res = await fetch(spec.tokenUrl, {
      method: 'POST',
      headers: FORM,
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    d = await res.json().catch(() => ({}));
  } catch (e: any) {
    return { status: 'error', error: e?.message ?? 'network error' };
  }
  if (d?.access_token) {
    return { status: 'authorized', token: String(d.access_token) };
  }
  switch (d?.error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      return { status: 'pending', interval: 5 }; // el server pide esperar más
    case 'access_denied':
      return { status: 'denied' };
    case 'expired_token':
      return { status: 'expired' };
    default:
      return { status: 'error', error: String(d?.error ?? d?.error_description ?? 'unknown') };
  }
}
