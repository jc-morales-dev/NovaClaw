/**
 * Hooks PostToolUse (B7) — al estilo Claude Code. El runner se conserva para
 * uso explícito y tests, pero el servidor NO lo conecta automáticamente a las
 * mutaciones mientras no exista confianza/aprobación por workspace. Un repo
 * clonado puede traer esta configuración ya escrita.
 *
 * Config en `novaclaw.hooks.json` (formato estilo Claude Code):
 *   { "PostToolUse": [ { "matcher": "file.edit|file.write",
 *                        "command": "prettier --write $FILE",
 *                        "description": "Formatear" } ] }
 *
 * Seguridad: escribir novaclaw.hooks.json exige aprobación obligatoria. Eso no
 * vuelve confiable un archivo preexistente; por eso la ejecución automática está
 * deshabilitada en agentRuntimes.ts.
 */
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

import { sanitizeChildEnv } from '../agent/childEnv';

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

/**
 * Variables que el shell expande al correr el hook.
 *
 * Antes la ruta se metía como TEXTO dentro del comando (`fmt $FILE` →
 * `fmt /w/x.ts`). Con un archivo llamado `nota$(comando).js` eso ejecutaba
 * `comando` al guardar — y la ruta la elige el agente. Pasándola por el entorno,
 * `$FILE` la expande el shell desde una variable, y el contenido de una variable
 * NO se re-evalúa para sustitución de comandos: el peor caso es word splitting
 * si el usuario no la entrecomilla.
 */
export function hookEnv(filePath: string, cwd: string): Record<string, string> {
  return { FILE: filePath, FILE_PATH: filePath, CWD: cwd };
}

/**
 * Normaliza el comando del hook. Ya NO inserta la ruta: los `$FILE`/`$FILE_PATH`/
 * `$CWD` quedan literales para que los expanda el shell desde el entorno.
 */
export function substituteHookCommand(command: string, _filePath?: string, _cwd?: string): string {
  if (process.platform !== 'win32') return command;
  // En Windows ejecutamos los hooks explícitos con PowerShell: conserva la
  // sintaxis documentada `$FILE` sin interpolar el valor dentro del comando.
  return command
    .replace(/\$FILE_PATH\b/g, '$env:FILE_PATH')
    .replace(/\$FILE\b/g, '$env:FILE')
    .replace(/\$CWD\b/g, '$env:CWD');
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
    const cmd = substituteHookCommand(h.command);
    const label = h.description || cmd;
    try {
      const { stdout, stderr } = await exec(cmd, {
        cwd,
        shell: process.platform === 'win32' ? 'powershell.exe' : undefined,
        timeout: HOOK_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        // Un novaclaw.hooks.json llega con el repo que el usuario clonó: es
        // código de un tercero. No puede ver las credenciales del agente.
        env: sanitizeChildEnv(process.env, hookEnv(filePath, cwd)),
      });
      const out = `${stdout ?? ''}${stderr ?? ''}`.trim();
      lines.push(`hook ✓ ${label}${out ? `: ${out.slice(0, 400)}` : ''}`);
    } catch (error: any) {
      const out = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim();
      lines.push(`hook ✗ ${label}: ${(out || error?.message || 'falló').slice(0, 400)}`);
    }
  }
  return `[hooks]\n${lines.join('\n')}`;
}
