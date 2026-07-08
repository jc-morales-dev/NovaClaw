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

/** Formatea contenido con números de línea (cat -n) + offset/limit 1-based. */
function formatFileWithLineNumbers(
 content: string,
 args: Record<string, any>,
 maxLines: number,
 maxBytes: number,
): string {
 const bounded = content.length > maxBytes ? content.slice(0, maxBytes) : content;
 const lines = bounded.split('\n');
 const totalLines = lines.length;
 const offset = Math.max(1, Math.floor(Number(args.offset)) || 1);
 const hasLimit = args.limit !== undefined && args.limit !== null;
 const limit = hasLimit ? Math.max(1, Math.floor(Number(args.limit))) : maxLines;
 if (offset > totalLines) return `[file has ${totalLines} lines; offset ${offset} is past the end]`;
 const startIdx = offset - 1;
 const endIdx = Math.min(startIdx + limit, totalLines);
 const width = String(endIdx).length;
 const numbered = lines.slice(startIdx, endIdx)
 .map((line, i) => `${String(offset + i).padStart(width, ' ')}\t${line}`)
 .join('\n');
 const notes: string[] = [];
 if (endIdx < totalLines) notes.push(`[... ${totalLines - endIdx} more lines below; use offset=${endIdx + 1} to continue ...]`);
 if (content.length > maxBytes) notes.push(`[file truncated at ${maxBytes} bytes]`);
 return notes.length ? `${numbered}\n${notes.join('\n')}` : numbered;
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
 const MAX_LINES = 2000;
 try {
 const raw = await shellReadFile(targetPath);
 const output = formatFileWithLineNumbers(raw, call.arguments, MAX_LINES, MAX_CHARS);
 return { name: 'file.read', command: targetPath, status: 'success', output, cwd };
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

 // ── file.edit ────────────────────────────────────────────────────────────
 if (call.tool === 'file.edit') {
 const targetPath = resolvePath(String(call.arguments.path ?? ''), cwd);
 const oldString = String(call.arguments.old_string ?? '');
 const newString = String(call.arguments.new_string ?? '');
 const replaceAll = Boolean(call.arguments.replace_all);
 if (!oldString) {
 return { name: 'file.edit', command: targetPath, status: 'error', output: 'old_string is empty.', cwd };
 }
 try {
 const content = await shellReadFile(targetPath);
 const occurrences = content.split(oldString).length - 1;
 if (occurrences === 0) {
 return { name: 'file.edit', command: targetPath, status: 'error', output: 'old_string was NOT found in the file. It must match exactly (whitespace included). Read the file again and copy the exact snippet.', cwd };
 }
 if (occurrences > 1 && !replaceAll) {
 return { name: 'file.edit', command: targetPath, status: 'error', output: `old_string appears ${occurrences} times. Add surrounding lines to make it unique, or set replace_all=true.`, cwd };
 }
 const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
 await shellWriteFile(targetPath, updated);
 const n = replaceAll ? occurrences : 1;
 return { name: 'file.edit', command: targetPath, status: 'success', output: `✓ Editado ${targetPath}: ${n} reemplazo${n === 1 ? '' : 's'}.`, cwd };
 } catch (err: any) {
 return { name: 'file.edit', command: targetPath, status: 'error', output: err.message, cwd };
 }
 }

 // ── file.grep ────────────────────────────────────────────────────────────
 if (call.tool === 'file.grep') {
 const targetPath = resolvePath(String(call.arguments.path ?? '.'), cwd);
 const rawPattern = String(call.arguments.pattern ?? '');
 const maxResults = Math.min(Number(call.arguments.max_results) || 60, 200);
 try {
 const safePath = sanitizeShellPath(targetPath);
 // Grep con -E; se filtran node_modules/.git después (toybox no tiene --exclude-dir).
 const safePattern = rawPattern.replace(/'/g, "'\\''");
 const cmd = `grep -rnE '${safePattern}' '${safePath}' 2>/dev/null | head -${maxResults * 3}`;
 const { output } = await shellRun(cmd, cwd, 30_000);
 const lines = output
 .split('\n')
 .filter((l) => l.trim() && !/\/(node_modules|\.git|dist|build)\//.test(l))
 .slice(0, maxResults);
 return {
 name: 'file.grep',
 command: `${targetPath} :: ${rawPattern}`,
 status: 'success',
 output: lines.length > 0 ? lines.join('\n') : `No matches for /${rawPattern}/.`,
 cwd,
 };
 } catch (err: any) {
 return { name: 'file.grep', command: `${targetPath} :: ${rawPattern}`, status: 'error', output: err.message, cwd };
 }
 }

 // ── web.fetch ────────────────────────────────────────────────────────────
 if (call.tool === 'web.fetch') {
 const url = String(call.arguments.url ?? '').trim();
 if (!/^https?:\/\//i.test(url)) {
 return { name: 'web.fetch', command: url, status: 'error', output: 'Only http(s) URLs are supported.', cwd };
 }
 try {
 const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
 let body = await res.text();
 const MAX_CHARS = 80 * 1024;
 body = body
 .replace(/<script[\s\S]*?<\/script>/gi, ' ')
 .replace(/<style[\s\S]*?<\/style>/gi, ' ')
 .replace(/<[^>]+>/g, ' ')
 .replace(/[ \t]+/g, ' ')
 .trim();
 if (body.length > MAX_CHARS) body = `${body.slice(0, MAX_CHARS)}\n[... truncado ...]`;
 return { name: 'web.fetch', command: url, status: res.ok ? 'success' : 'error', output: body || `HTTP ${res.status}`, cwd };
 } catch (err: any) {
 return { name: 'web.fetch', command: url, status: 'error', output: `Fetch falló (CORS/red): ${err?.message ?? err}`, cwd };
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

 // ── image.view ─────────────────────────────────────────────────────────────
 if (call.tool === 'image.view') {
 const targetPath = resolvePath(String(call.arguments.path ?? ''), cwd);
 const ext = targetPath.slice(targetPath.lastIndexOf('.')).toLowerCase();
 const mediaType = ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<string, string>)[ext];
 if (!mediaType) {
 return { name: 'image.view', command: targetPath, status: 'error', output: `Unsupported image type "${ext}". Use jpg, png, webp or gif.`, cwd };
 }
 try {
 const safePath = sanitizeShellPath(targetPath);
 // base64 del archivo (una sola línea) vía el shell del prefix.
 const { output, exitCode } = await shellRun(`base64 -w0 '${safePath}' 2>/dev/null || base64 '${safePath}'`, cwd, 30_000);
 const data = output.replace(/\s+/g, '');
 if (exitCode !== 0 || !data) {
 return { name: 'image.view', command: targetPath, status: 'error', output: 'No se pudo leer la imagen.', cwd };
 }
 return { name: 'image.view', command: targetPath, status: 'success', output: `Loaded image ${targetPath}. See the attached image.`, image: { mediaType, data }, cwd };
 } catch (err: any) {
 return { name: 'image.view', command: targetPath, status: 'error', output: err.message, cwd };
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
