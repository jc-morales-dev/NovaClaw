/**
 * toolsFsHelpers.ts — Helpers de sistema de archivos SOLO-Node compartidos por
 * el executor local (tools.ts) y sus módulos por-concern (toolsPhone.ts,
 * toolsSearch.ts). Usan node:path, así que NO son browser-safe (a diferencia de
 * toolShared.ts, que es puro). No los importes desde el bundle del WebView.
 */
import path from 'node:path';

export type ToolExecutionContext = {
  cwd: string;
  workspaceRoot: string;
};

/** Resuelve un path relativo contra el cwd; deja los absolutos intactos. */
export function resolveTargetPath(inputPath: string, cwd: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}

// Archivos con secretos que el agente NUNCA debe leer (API key, sesiones,
// credenciales de firma). Se bloquean por nombre para cortar la fuga de key
// vía file.read/file.grep + web.fetch (inyección de prompt).
const PROTECTED_BASENAMES = new Set([
  'novaclaw.config.json',
  'novaclaw.sessions.json',
  'keystore.properties',
]);

export function isProtectedPath(p: string): boolean {
  const base = path.basename(p).toLowerCase();
  if (PROTECTED_BASENAMES.has(base)) return true;
  return base.endsWith('.jks') || base.endsWith('.keystore');
}
