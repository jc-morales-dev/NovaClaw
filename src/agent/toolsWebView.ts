/**
 * toolsWebView.ts — Tool executor autónomo para el APK (sin Termux).
 *
 * Usa ShellPlugin (ProcessBuilder → /system/bin/sh) en lugar de apps externas.
 * El workspace vive en el storage privado de la app:
 * /data/data/com.novaclaw.app/files/workspace/
 *
 * Operaciones con archivos grandes (writeFile, readFile) van directo
 * a través del plugin nativo desde Kotlin, evitando escapado de shell.
 */

import type { ToolCallLike, ToolExecutionResult } from './types';

const DEFAULT_CWD = '/data/data/com.novaclaw.app/files/workspace';

function getShell(): any {
 return (window as any).Capacitor?.Plugins?.Shell ?? null;
}

async function shellRun(
 command: string,
 cwd: string,
 timeoutMs = 30_000,
): Promise<{ output: string; cwd: string; exitCode: number }> {
 const Shell = getShell();
 if (!Shell) {
 return {
 output:
 '[Error] ShellPlugin no disponible. Verifica que MainActivity registra ShellPlugin.',
 cwd,
 exitCode: -1,
 };
 }
 try {
 const res = await Shell.run({ command, cwd, timeoutMs });
 return {
 output: res.output ?? '',
 cwd: res.cwd ?? cwd,
 exitCode: res.exitCode ?? 0,
 };
 } catch (err: any) {
 return {
 output: `[Error Shell] ${err?.message ?? String(err)}`,
 cwd,
 exitCode: -1,
 };
 }
}

/** Escribe un archivo usando el método nativo (evita límites de argv). */
async function shellWriteFile(path: string, content: string): Promise<void> {
 const Shell = getShell();
 if (Shell?.writeFile) {
 await Shell.writeFile({ path, content });
 return;
 }
 // Fallback: chunked echo via shell (para contenido < 128 KB)
 // Use printf with base64 to avoid shell injection from path or content
 const encoded = btoa(unescape(encodeURIComponent(content)));
 // Sanitize path: reject if it contains any shell metacharacters
 if (/[`$\\|;&<>(){}!\n\r]/.test(path)) {
 throw new Error(`Invalid path characters: ${path}`);
 }
 await shellRun(`printf '%s' '${encoded}' | base64 -d > '${path}'`, DEFAULT_CWD);
}

/** Lee un archivo usando el método nativo (evita límites de buffer de shell). */
async function shellReadFile(path: string): Promise<string> {
 const Shell = getShell();
 if (Shell?.readFile) {
 try {
 const res = await Shell.readFile({ path });
 return res.content ?? '';
 } catch (err: any) {
 throw new Error(err?.message ?? String(err));
 }
 }
 // Fallback via cat — sanitize path
 if (/[`$\\|;&<>(){}!\n\r]/.test(path)) {
 throw new Error(`Invalid path characters: ${path}`);
 }
 const { output } = await shellRun(`cat '${path}'`, DEFAULT_CWD);
 return output;
}

/** Resuelve rutas relativas/~ sin Node.js path. */
function resolvePath(inputPath: string, cwd: string): string {
 if (!inputPath) return cwd;
 const expanded = inputPath.startsWith('~')
 ? inputPath.replace('~', DEFAULT_CWD)
 : inputPath;
 if (expanded.startsWith('/')) return expanded;
 return `${cwd.replace(/\/$/, '')}/${expanded}`;
}

/**
 * Sanitizes a path for safe use in shell single-quoted strings.
 * Rejects paths with shell metacharacters that could break out of quoting.
 */
function sanitizeShellPath(path: string): string {
 if (/[`$\\|;&<>(){}!\n\r']/.test(path)) {
 throw new Error(`Path contains unsafe shell characters: ${path}`);
 }
 return path;
}

/**
 * Sanitizes a search query for safe use in find -name patterns.
 * Removes characters that could break out of the find command.
 */
function sanitizeFindQuery(query: string): string {
 // Remove shell metacharacters and find-specific characters
 return query.replace(/[`$\\|;&<>(){}!\n\r'"]/g, '');
}

// ── Tool executor ─────────────────────────────────────────────────────────────

export function createWebViewToolExecutor() {
 return async function executeToolCall(
 call: ToolCallLike,
 context: { cwd: string; workspaceRoot: string },
 ): Promise<ToolExecutionResult> {
 const cwd = context.cwd || DEFAULT_CWD;

 // ── terminal.run ─────────────────────────────────────────────────────────
 if (call.tool === 'terminal.run') {
 const command = String(call.arguments.command ?? '').trim();

 if (command === 'pwd') {
 return { name: 'terminal.run', command, status: 'success', output: cwd, cwd };
 }

 const { output, cwd: newCwd, exitCode } = await shellRun(command, cwd);
 const isError = exitCode !== 0 || output.startsWith('[Error');
 return {
 name: 'terminal.run',
 command,
 status: isError ? 'error' : 'success',
 output: output || '(no output)',
 cwd: newCwd,
 };
 }

 // ── file.read ────────────────────────────────────────────────────────────
 if (call.tool === 'file.read') {
 const targetPath = resolvePath(String(call.arguments.path ?? ''), cwd);
 const MAX_CHARS = 256 * 1024;
 try {
 const raw = await shellReadFile(targetPath);
 const content = raw.length > MAX_CHARS
 ? `${raw.slice(0, MAX_CHARS)}\n\n[... truncado — ${raw.length} chars ...]`
 : raw;
 return { name: 'file.read', command: targetPath, status: 'success', output: content, cwd };
 } catch (err: any) {
 return { name: 'file.read', command: targetPath, status: 'error', output: err.message, cwd };
 }
 }

 // ── file.write ───────────────────────────────────────────────────────────
 if (call.tool === 'file.write') {
 const targetPath = resolvePath(String(call.arguments.path ?? ''), cwd);
 const content = String(call.arguments.content ?? '');
 try {
 // Crear directorio padre primero
 const dir = targetPath.substring(0, targetPath.lastIndexOf('/'));
 if (dir) {
 const safeDir = sanitizeShellPath(dir);
 await shellRun(`mkdir -p '${safeDir}'`, cwd);
 }
 await shellWriteFile(targetPath, content);
 return { name: 'file.write', command: targetPath, status: 'success', output: `✓ Archivo escrito: ${targetPath}`, cwd };
 } catch (err: any) {
 return { name: 'file.write', command: targetPath, status: 'error', output: err.message, cwd };
 }
 }

 // ── file.list ────────────────────────────────────────────────────────────
 if (call.tool === 'file.list') {
 const targetPath = resolvePath(String(call.arguments.path ?? '.'), cwd);
 try {
 const safePath = sanitizeShellPath(targetPath);
 const { output, exitCode } = await shellRun(`ls -la '${safePath}'`, cwd);
 return {
 name: 'file.list',
 command: targetPath,
 status: exitCode === 0 ? 'success' : 'error',
 output: output || '(empty directory)',
 cwd,
 };
 } catch (err: any) {
 return { name: 'file.list', command: targetPath, status: 'error', output: err.message, cwd };
 }
 }

 // ── workspace.mkdir ──────────────────────────────────────────────────────
 if (call.tool === 'workspace.mkdir') {
 const targetPath = resolvePath(String(call.arguments.path ?? ''), cwd);
 try {
 const safePath = sanitizeShellPath(targetPath);
 const { output, exitCode } = await shellRun(`mkdir -p '${safePath}'`, cwd);
 return {
 name: 'workspace.mkdir',
 command: targetPath,
 status: exitCode === 0 ? 'success' : 'error',
 output: exitCode === 0 ? `✓ Directorio creado: ${targetPath}` : output,
 cwd,
 };
 } catch (err: any) {
 return { name: 'workspace.mkdir', command: targetPath, status: 'error', output: err.message, cwd };
 }
 }

 // ── file.search ──────────────────────────────────────────────────────────
 if (call.tool === 'file.search') {
 const targetPath = resolvePath(String(call.arguments.path ?? '.'), cwd);
 const rawQuery = String(call.arguments.query ?? '');
 try {
 const safePath = sanitizeShellPath(targetPath);
 const safeQuery = sanitizeFindQuery(rawQuery);
 const cmd = `find '${safePath}' -name '*${safeQuery}*' -not -path '*/node_modules/*' 2>/dev/null | head -50`;
 const { output, exitCode } = await shellRun(cmd, cwd);
 return {
 name: 'file.search',
 command: `${targetPath} :: ${rawQuery}`,
 status: exitCode === 0 ? 'success' : 'error',
 output: output || 'No se encontraron resultados.',
 cwd,
 };
 } catch (err: any) {
 return { name: 'file.search', command: `${targetPath} :: ${rawQuery}`, status: 'error', output: err.message, cwd };
 }
 }

 // ── file.delete ──────────────────────────────────────────────────────────
 if (call.tool === 'file.delete') {
 const targetPath = resolvePath(String(call.arguments.path ?? ''), cwd);
 try {
 const safePath = sanitizeShellPath(targetPath);
 const { output, exitCode } = await shellRun(`rm -rf '${safePath}'`, cwd);
 return {
 name: 'file.delete',
 command: targetPath,
 status: exitCode === 0 ? 'success' : 'error',
 output: exitCode === 0 ? `✓ Eliminado: ${targetPath}` : output,
 cwd,
 };
 } catch (err: any) {
 return { name: 'file.delete', command: targetPath, status: 'error', output: err.message, cwd };
 }
 }

 throw new Error(`Tool no soportado: ${call.tool}`);
 };
}
