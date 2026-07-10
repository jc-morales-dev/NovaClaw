/**
 * Conectores del teléfono: puente con la capa nativa (window.NovaClawNative)
 * para pedir permisos reales de Android desde Ajustes. En navegador (sin la
 * APK) todo se reporta como no disponible y los botones quedan informativos.
 */

export type ConnectorKey =
  | 'files'
  | 'camera'
  | 'location'
  | 'contacts'
  | 'calendar'
  | 'microphone'
  | 'allFiles';

export type ConnectorState = Record<ConnectorKey, boolean>;

interface NovaClawNative {
  getConnectors(): string;
  requestConnector(key: string): void;
  openAppSettings(): void;
  /** API keys cifradas en el Android Keystore, UNA por proveedor (si la APK lo expone). */
  saveApiKey?(provider: string, key: string): void;
  getApiKey?(provider: string): string;
  hasApiKey?(provider: string): boolean;
  clearApiKey?(provider: string): void;
  apiKeyProviders?(): string;
}

declare global {
  interface Window {
    NovaClawNative?: NovaClawNative;
  }
}

/** ¿Corre dentro de la APK (con puente nativo)? */
export function hasNativeConnectors(): boolean {
  return typeof window !== 'undefined' && !!window.NovaClawNative;
}

const EMPTY: ConnectorState = {
  files: false,
  camera: false,
  location: false,
  contacts: false,
  calendar: false,
  microphone: false,
  allFiles: false,
};

export function getConnectors(): ConnectorState {
  if (!hasNativeConnectors()) return { ...EMPTY };
  try {
    const parsed = JSON.parse(window.NovaClawNative!.getConnectors());
    return { ...EMPTY, ...parsed };
  } catch {
    return { ...EMPTY };
  }
}

export function requestConnector(key: ConnectorKey): void {
  window.NovaClawNative?.requestConnector(key);
}

export function openAppSettings(): void {
  window.NovaClawNative?.openAppSettings();
}

/** Suscribe a los cambios que dispara la capa nativa al conceder/denegar. */
export function onConnectorsChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('novaclaw-connectors-changed', listener);
  return () => window.removeEventListener('novaclaw-connectors-changed', listener);
}
