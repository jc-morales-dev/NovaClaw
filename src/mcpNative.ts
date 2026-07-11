/**
 * mcpNative.ts — Puente a las funciones nativas de MCP (Keystore + huella).
 *
 * En el teléfono usa `window.NovaClawNative` (ConnectorBridge). En web/PC esos
 * métodos no existen, así que degrada con gracia: guardar/consultar secretos son
 * no-ops y la huella se resuelve como "ok" (el flujo de dev pasa el token al
 * server por otro camino).
 */

type NovaBridge = {
  saveMcpSecret?: (id: string, value: string) => void;
  hasMcpSecret?: (id: string) => boolean;
  clearMcpSecret?: (id: string) => void;
  mcpSecretIds?: () => string;
  confirmWithBiometric?: (requestId: string, title: string, subtitle: string) => void;
};

function bridge(): NovaBridge | undefined {
  return (window as any).NovaClawNative as NovaBridge | undefined;
}

/** ¿Estamos en el teléfono (con el bridge nativo)? */
export function hasNativeMcp(): boolean {
  return typeof bridge()?.saveMcpSecret === 'function';
}

/** Guarda el token de un MCP cifrado en el Keystore (teléfono). No-op en web. */
export function saveMcpSecret(id: string, value: string): void {
  try { bridge()?.saveMcpSecret?.(id, value); } catch { /* web */ }
}

/** ¿Hay un token guardado para ese MCP? (el valor nunca se puede leer desde el front) */
export function hasMcpSecret(id: string): boolean {
  try { return bridge()?.hasMcpSecret?.(id) ?? false; } catch { return false; }
}

export function clearMcpSecret(id: string): void {
  try { bridge()?.clearMcpSecret?.(id); } catch { /* web */ }
}

export function mcpSecretIds(): string[] {
  try { return JSON.parse(bridge()?.mcpSecretIds?.() ?? '[]'); } catch { return []; }
}

let biometricSeq = 0;

/**
 * Pide confirmación con huella/PIN antes de instalar un MCP nuevo. Devuelve true
 * si el usuario confirmó (o si el equipo no tiene biometría). En web: true.
 */
export function confirmBiometric(title: string, subtitle: string): Promise<boolean> {
  const b = bridge();
  if (!b?.confirmWithBiometric) return Promise.resolve(true);
  const requestId = `bio_${Date.now()}_${biometricSeq++}`;
  return new Promise((resolve) => {
    let done = false;
    const onResult = (e: Event) => {
      const detail = (e as CustomEvent).detail as { requestId: string; ok: boolean } | undefined;
      if (!detail || detail.requestId !== requestId) return;
      done = true;
      window.removeEventListener('novaclaw-biometric-result', onResult as EventListener);
      resolve(Boolean(detail.ok));
    };
    window.addEventListener('novaclaw-biometric-result', onResult as EventListener);
    // Red de seguridad: si el nativo no responde en 60s, no dejamos el flujo colgado.
    setTimeout(() => {
      if (done) return;
      window.removeEventListener('novaclaw-biometric-result', onResult as EventListener);
      resolve(false);
    }, 60000);
    try { b.confirmWithBiometric(requestId, title, subtitle); }
    catch { window.removeEventListener('novaclaw-biometric-result', onResult as EventListener); resolve(true); }
  });
}
