/**
 * Hooks PostToolUse (B7) — al estilo Claude Code. Tras una mutación exitosa
 * (file.write / file.edit / file.edit_multi) el agente corre los comandos
 * configurados (formatear, lint, etc.) y su salida se le devuelve, así el
 * formateo/chequeo pasa SIN que el modelo tenga que acordarse.
 *
 * Config en `novaclaw.hooks.json` (formato estilo Claude Code):
 *   { "PostToolUse": [ { "matcher": "file.edit|file.write",
 *                        "command": "prettier --write $FILE",
 *                        "description": "Formatear" } ] }
 *
 * Seguridad: escribir novaclaw.hooks.json exige aprobación del usuario (está en
 * la lista de archivos críticos de safety.ts), así el agente no puede
 * auto-instalar un hook malicioso en silencio.
 */
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execCb);

const HOOKS_FILE = 'novaclaw.hooks.json';
const HOOK_TIMEOUT_MS = 30_000;

export type HookDef = { matcher?: string; command: string; description?: string };
export type HooksConfig = { PostToolUse?: HookDef[] };

/** Lee y parsea novaclaw.hooks.json (o {} si falta / está roto). */
export function readHooksConfig(cwd: string): HooksConfig {
  try {
    const p = path.join(cwd, HOOKS_FILE);
    if (!fs.existsSync(p)) return {};
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as HooksConfig) : {};
  } catch {
    return {};
  }
}

/** ¿El matcher (regex sobre el nombre de tool) aplica? Sin matcher = todos. */
export function hookMatches(matcher: string | undefined, tool: string): boolean {
  if (!matcher || !matcher.trim()) return true;
  try {
    return new RegExp(matcher).test(tool);
  } catch {
    return matcher === tool;
  }
}

/** Sustituye $FILE / $FILE_PATH / $CWD en el comando del hook. */
export function substituteHookCommand(command: string, filePath: string, cwd: string): string {
  return command
    .replace(/\$FILE_PATH\b/g, filePath)
    .replace(/\$FILE\b/g, filePath)
    .replace(/\$CWD\b/g, cwd);
}

/** Devuelve los hooks PostToolUse que aplican a este tool (puro, testeable). */
export function selectPostToolUseHooks(cfg: HooksConfig, tool: string): HookDef[] {
  const hooks = Array.isArray(cfg.PostToolUse) ? cfg.PostToolUse : [];
  return hooks.filter((h) => h && typeof h.command === 'string' && h.command.trim() && hookMatches(h.matcher, tool));
}

/**
 * Corre los hooks PostToolUse que matcheen y devuelve un resumen (o null si no
 * hay ninguno). Best-effort: un hook que falla se reporta, no rompe el turno.
 */
export async function runPostToolUseHooks(
  tool: string,
  filePath: string,
  cwd: string,
): Promise<string | null> {
  const matching = selectPostToolUseHooks(readHooksConfig(cwd), tool);
  if (matching.length === 0) return null;

  const lines: string[] = [];
  for (const h of matching) {
    const cmd = substituteHookCommand(h.command, filePath, cwd);
    const label = h.description || cmd;
    try {
      const { stdout, stderr } = await exec(cmd, { cwd, timeout: HOOK_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
      const out = `${stdout ?? ''}${stderr ?? ''}`.trim();
      lines.push(`hook ✓ ${label}${out ? `: ${out.slice(0, 400)}` : ''}`);
    } catch (error: any) {
      const out = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim();
      lines.push(`hook ✗ ${label}: ${(out || error?.message || 'falló').slice(0, 400)}`);
    }
  }
  return `[hooks]\n${lines.join('\n')}`;
}
