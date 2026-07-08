import { exec as execCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ToolCallLike, ToolExecutionResult } from './types';

const exec = promisify(execCallback);

type ToolExecutionContext = {
  cwd: string;
  workspaceRoot: string;
};

function resolveTargetPath(inputPath: string, cwd: string): string {
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
function isProtectedPath(p: string): boolean {
  const base = path.basename(p).toLowerCase();
  if (PROTECTED_BASENAMES.has(base)) return true;
  return base.endsWith('.jks') || base.endsWith('.keystore');
}

// SSRF guard: web.fetch no debe alcanzar loopback ni redes internas (sus propios
// servidores 127.0.0.1:8088/8099, la LAN, o metadata de nube 169.254.x).
function isBlockedFetchHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '::') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  return /^fe80:/i.test(h) || /^fc/i.test(h) || /^fd/i.test(h);
}

/**
 * Formatea el contenido de un archivo con números de línea (estilo `cat -n`),
 * respetando offset/limit (1-based) para leer ventanas de archivos grandes.
 * Así el modelo puede referenciar líneas exactas al editar.
 */
// Extensiones de imagen soportadas por los modelos de vision y su media type.
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Lee un archivo de imagen y lo devuelve como base64 + media type para vision. */
async function loadImageAsBase64(imagePath: string): Promise<{ mediaType: string; data: string }> {
  const ext = path.extname(imagePath).toLowerCase();
  const mediaType = IMAGE_MEDIA_TYPES[ext];
  if (!mediaType) {
    throw new Error(`Unsupported image type "${ext}". Use jpg, png, webp or gif.`);
  }
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
  const stat = await fs.stat(imagePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${imagePath}`);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large (${Math.round(stat.size / 1024)} KB, max 5 MB).`);
  }
  const buf = await fs.readFile(imagePath);
  return { mediaType, data: buf.toString('base64') };
}

function formatWithLineNumbers(
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

  const startIdx = offset - 1;
  const endIdx = Math.min(startIdx + limit, totalLines);
  const slice = lines.slice(startIdx, endIdx);

  const width = String(endIdx).length;
  const numbered = slice
    .map((line, i) => `${String(offset + i).padStart(width, ' ')}\t${line}`)
    .join('\n');

  const notes: string[] = [];
  if (offset > totalLines) {
    return `[file has ${totalLines} lines; offset ${offset} is past the end]`;
  }
  if (endIdx < totalLines) {
    notes.push(`[... ${totalLines - endIdx} more lines below; use offset=${endIdx + 1} to continue ...]`);
  }
  if (content.length > maxBytes) {
    notes.push(`[file truncated at ${maxBytes} bytes]`);
  }
  return notes.length ? `${numbered}\n${notes.join('\n')}` : numbered;
}

// Puente con el servidor de capacidades nativas (Kotlin) — cámara/GPS/contactos.
const NATIVE_TOOLS_BASE = process.env.NOVACLAW_NATIVE_URL || 'http://127.0.0.1:8099';

async function callNativeTool(pathAndQuery: string): Promise<any> {
  const token = process.env.NOVACLAW_TOKEN || '';
  const res = await fetch(`${NATIVE_TOOLS_BASE}${pathAndQuery}`, {
    signal: AbortSignal.timeout(15000),
    headers: token ? { 'X-Nova-Token': token } : undefined,
  });
  const data = await res.json();
  if (data && data.error) {
    throw new Error(data.error);
  }
  return data;
}

async function runTerminalCommand(command: string, cwd: string): Promise<ToolExecutionResult> {
  const trimmed = command.trim();
  // En Android (shell Linux real) mandamos ls/cat al shell nativo; en la PC se
  // mantienen los atajos JS. cd/pwd siempre se manejan acá (estado del cwd).
  const nativeShell = !!process.env.SHELL;

  if (trimmed === 'pwd') {
    return {
      name: 'terminal.run',
      command,
      status: 'success',
      output: cwd,
      cwd,
    };
  }

  if (trimmed === 'cd') {
    return {
      name: 'terminal.run',
      command,
      status: 'success',
      output: '',
      cwd,
    };
  }

  if (trimmed.startsWith('cd ')) {
    const nextCwd = path.resolve(cwd, trimmed.slice(3).trim());
    return {
      name: 'terminal.run',
      command,
      status: 'success',
      output: '',
      cwd: nextCwd,
    };
  }

  if (!nativeShell && trimmed === 'ls') {
    const files = await fs.readdir(cwd);
    return {
      name: 'terminal.run',
      command,
      status: 'success',
      output: files.join('\n'),
      cwd,
    };
  }

  if (!nativeShell && trimmed.startsWith('cat ')) {
    const filePath = resolveTargetPath(trimmed.slice(4).trim(), cwd);
    const content = await fs.readFile(filePath, 'utf8');
    return {
      name: 'terminal.run',
      command,
      status: 'success',
      output: content,
      cwd,
    };
  }

  try {
    // En Android, SHELL apunta al sh del Linux embebido ($PREFIX/bin/sh).
    // En la PC (dev) queda undefined y exec usa el shell por defecto del SO.
    const { stdout, stderr } = await exec(command, { cwd, timeout: 15000, shell: process.env.SHELL || undefined });
    return {
      name: 'terminal.run',
      command,
      status: 'success',
      output: [stdout, stderr].filter(Boolean).join('').trim() || '(Command completed with no output)',
      cwd,
    };
  } catch (error: any) {
    return {
      name: 'terminal.run',
      command,
      status: 'error',
      output: [error.stdout, error.stderr, error.message].filter(Boolean).join('').trim() || 'Command failed',
      cwd,
    };
  }
}

export function createLocalToolExecutor() {
  return async function executeToolCall(
    call: ToolCallLike,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (call.tool === 'terminal.run') {
      return runTerminalCommand(String(call.arguments.command ?? ''), context.cwd);
    }

    if (call.tool === 'file.read') {
      const targetPath = resolveTargetPath(String(call.arguments.path ?? ''), context.cwd);
      if (isProtectedPath(targetPath)) {
        return {
          name: 'file.read',
          command: targetPath,
          status: 'error',
          output: 'Access denied: this file holds secrets (API key / credentials) and cannot be read.',
          cwd: context.cwd,
        };
      }
      const MAX_READ_BYTES = 256 * 1024; // 256 KB hard cap to protect the agent context window.
      const MAX_LINES = 2000; // límite de líneas por lectura sin rango explícito
      const stat = await fs.stat(targetPath);
      if (!stat.isFile()) {
        return {
          name: 'file.read',
          command: targetPath,
          status: 'error',
          output: `Not a regular file: ${targetPath}`,
          cwd: context.cwd,
        };
      }

      const fullContent = await fs.readFile(targetPath, 'utf8');
      const output = formatWithLineNumbers(fullContent, call.arguments, MAX_LINES, MAX_READ_BYTES);

      return {
        name: 'file.read',
        command: targetPath,
        status: 'success',
        output,
        cwd: context.cwd,
      };
    }

    if (call.tool === 'file.write') {
      const targetPath = resolveTargetPath(String(call.arguments.path ?? ''), context.cwd);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, String(call.arguments.content ?? ''), 'utf8');
      return {
        name: 'file.write',
        command: targetPath,
        status: 'success',
        output: `Wrote file: ${targetPath}`,
        cwd: context.cwd,
      };
    }

    if (call.tool === 'file.edit') {
      const targetPath = resolveTargetPath(String(call.arguments.path ?? ''), context.cwd);
      const oldString = String(call.arguments.old_string ?? '');
      const newString = String(call.arguments.new_string ?? '');
      const replaceAll = Boolean(call.arguments.replace_all);

      if (!oldString) {
        return {
          name: 'file.edit',
          command: targetPath,
          status: 'error',
          output: 'old_string is empty. Provide the exact text to replace.',
          cwd: context.cwd,
        };
      }

      let content: string;
      try {
        content = await fs.readFile(targetPath, 'utf8');
      } catch {
        return {
          name: 'file.edit',
          command: targetPath,
          status: 'error',
          output: `File not found: ${targetPath}. Use file_write to create new files.`,
          cwd: context.cwd,
        };
      }

      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) {
        return {
          name: 'file.edit',
          command: targetPath,
          status: 'error',
          output:
            'old_string was NOT found in the file. It must match exactly, including whitespace and indentation. Read the file again and copy the exact snippet.',
          cwd: context.cwd,
        };
      }
      if (occurrences > 1 && !replaceAll) {
        return {
          name: 'file.edit',
          command: targetPath,
          status: 'error',
          output: `old_string appears ${occurrences} times in the file. Include more surrounding lines to make it unique, or set replace_all=true to replace every occurrence.`,
          cwd: context.cwd,
        };
      }

      const updated = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);
      await fs.writeFile(targetPath, updated, 'utf8');

      const replacedCount = replaceAll ? occurrences : 1;
      return {
        name: 'file.edit',
        command: targetPath,
        status: 'success',
        output: `Edited ${targetPath}: replaced ${replacedCount} occurrence${replacedCount === 1 ? '' : 's'}.`,
        cwd: context.cwd,
      };
    }

    if (call.tool === 'file.grep') {
      const targetPath = resolveTargetPath(String(call.arguments.path ?? '.'), context.cwd);
      const rawPattern = String(call.arguments.pattern ?? '');
      const maxResults = Math.min(Number(call.arguments.max_results) || 60, 200);

      let regex: RegExp;
      try {
        regex = new RegExp(rawPattern);
      } catch (error: any) {
        return {
          name: 'file.grep',
          command: `${targetPath} :: ${rawPattern}`,
          status: 'error',
          output: `Invalid regular expression: ${error?.message ?? rawPattern}`,
          cwd: context.cwd,
        };
      }

      const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.gradle', '.next', '__pycache__']);
      const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|zip|jar|apk|so|dex|pdf|mp3|mp4|woff2?|ttf|eot|class|bin|exe|dll)$/i;
      const MAX_FILE_BYTES = 512 * 1024;
      const MAX_LINE_CHARS = 300;
      const matches: string[] = [];
      let scannedFiles = 0;

      async function grepFile(filePath: string): Promise<void> {
        if (matches.length >= maxResults || BINARY_EXT.test(filePath)) return;
        if (isProtectedPath(filePath)) return; // no filtrar secretos (API key, etc.)
        let stat;
        try {
          stat = await fs.stat(filePath);
        } catch {
          return;
        }
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
        scannedFiles += 1;
        let text: string;
        try {
          text = await fs.readFile(filePath, 'utf8');
        } catch {
          return;
        }
        if (text.includes('\0')) return; // binario disfrazado
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && matches.length < maxResults; i += 1) {
          if (regex.test(lines[i])) {
            const line = lines[i].length > MAX_LINE_CHARS ? `${lines[i].slice(0, MAX_LINE_CHARS)}…` : lines[i];
            matches.push(`${filePath}:${i + 1}: ${line.trim()}`);
          }
        }
      }

      async function walkGrep(dir: string, depth: number): Promise<void> {
        if (depth > 10 || matches.length >= maxResults) return;
        let entries: Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (matches.length >= maxResults) return;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
              await walkGrep(full, depth + 1);
            }
          } else {
            await grepFile(full);
          }
        }
      }

      try {
        const rootStat = await fs.stat(targetPath);
        if (rootStat.isFile()) {
          await grepFile(targetPath);
        } else {
          await walkGrep(targetPath, 0);
        }
      } catch {
        return {
          name: 'file.grep',
          command: `${targetPath} :: ${rawPattern}`,
          status: 'error',
          output: `Path not found: ${targetPath}`,
          cwd: context.cwd,
        };
      }

      const header = matches.length >= maxResults ? `[showing first ${maxResults} matches]\n` : '';
      return {
        name: 'file.grep',
        command: `${targetPath} :: ${rawPattern}`,
        status: 'success',
        output: matches.length > 0
          ? `${header}${matches.join('\n')}`
          : `No matches for /${rawPattern}/ (${scannedFiles} files scanned).`,
        cwd: context.cwd,
      };
    }

    if (call.tool === 'web.fetch') {
      const url = String(call.arguments.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) {
        return {
          name: 'web.fetch',
          command: url,
          status: 'error',
          output: 'Only http(s) URLs are supported.',
          cwd: context.cwd,
        };
      }
      let parsedHost = '';
      try { parsedHost = new URL(url).hostname; } catch { parsedHost = ''; }
      if (!parsedHost || isBlockedFetchHost(parsedHost)) {
        return {
          name: 'web.fetch',
          command: url,
          status: 'error',
          output: 'Blocked: web_fetch cannot reach localhost or private/internal network addresses (SSRF protection).',
          cwd: context.cwd,
        };
      }
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(20000),
          headers: { 'User-Agent': 'NovaClaw/1.0 (Android agent)', Accept: 'text/html,text/plain,application/json,*/*' },
          redirect: 'follow',
        });
        const contentType = res.headers.get('content-type') ?? '';
        let body = await res.text();
        if (/text\/html/i.test(contentType)) {
          // Reducir HTML a texto legible para no quemar contexto.
          body = body
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n\s*\n\s*\n+/g, '\n\n')
            .trim();
        }
        const MAX_CHARS = 80 * 1024;
        if (body.length > MAX_CHARS) {
          body = `${body.slice(0, MAX_CHARS)}\n\n[... truncated, response was ${body.length} chars ...]`;
        }
        return {
          name: 'web.fetch',
          command: url,
          status: res.ok ? 'success' : 'error',
          output: res.ok ? body || '(empty response)' : `HTTP ${res.status}: ${body.slice(0, 500)}`,
          cwd: context.cwd,
        };
      } catch (error: any) {
        return {
          name: 'web.fetch',
          command: url,
          status: 'error',
          output: `Fetch failed: ${error?.message ?? 'network error'}`,
          cwd: context.cwd,
        };
      }
    }

    if (call.tool === 'file.list') {
      const targetPath = resolveTargetPath(String(call.arguments.path ?? '.'), context.cwd);
      const entries = await fs.readdir(targetPath);
      return {
        name: 'file.list',
        command: targetPath,
        status: 'success',
        output: entries.join('\n'),
        cwd: context.cwd,
      };
    }

    if (call.tool === 'workspace.mkdir') {
      const targetPath = resolveTargetPath(String(call.arguments.path ?? ''), context.cwd);
      await fs.mkdir(targetPath, { recursive: true });
      return {
        name: 'workspace.mkdir',
        command: targetPath,
        status: 'success',
        output: `Created directory: ${targetPath}`,
        cwd: context.cwd,
      };
    }

  if (call.tool === 'file.search') {
    const targetPath = resolveTargetPath(String(call.arguments.path ?? '.'), context.cwd);
    const query = String(call.arguments.query ?? '').toLowerCase();
    const maxResults = 50;
    const matches: string[] = [];

    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 8 || matches.length >= maxResults) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (matches.length >= maxResults) return;
        if (entry.name.toLowerCase().includes(query)) {
          matches.push(path.join(dir, entry.name));
        }
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await walk(path.join(dir, entry.name), depth + 1);
        }
      }
    }

    await walk(targetPath, 0);
    return {
      name: 'file.search',
      command: `${targetPath} :: ${query}`,
      status: 'success',
      output: matches.length > 0 ? matches.join('\n') : 'No matches found.',
      cwd: context.cwd,
    };
  }

    // ── Herramientas nativas del teléfono (vía servidor Kotlin en :8099) ──────
    if (call.tool === 'phone.location') {
      try {
        const loc = await callNativeTool('/location');
        return {
          name: 'phone.location',
          command: 'location',
          status: 'success',
          output: JSON.stringify(loc),
          cwd: context.cwd,
        };
      } catch (error: any) {
        return {
          name: 'phone.location',
          command: 'location',
          status: 'error',
          output: error?.message ?? 'Could not read location.',
          cwd: context.cwd,
        };
      }
    }

    if (call.tool === 'phone.contacts') {
      const q = String(call.arguments.query ?? '').trim();
      try {
        const data = await callNativeTool(`/contacts?q=${encodeURIComponent(q)}`);
        const list = (data.contacts ?? [])
          .map((c: any) => `${c.name || '(sin nombre)'} — ${c.number}`)
          .join('\n');
        return {
          name: 'phone.contacts',
          command: `contacts ${q}`.trim(),
          status: 'success',
          output: list || 'No matching contacts.',
          cwd: context.cwd,
        };
      } catch (error: any) {
        return {
          name: 'phone.contacts',
          command: `contacts ${q}`.trim(),
          status: 'error',
          output: error?.message ?? 'Could not read contacts.',
          cwd: context.cwd,
        };
      }
    }

    if (call.tool === 'phone.photo') {
      const facing = String(call.arguments.facing ?? 'back');
      try {
        const data = await callNativeTool(`/photo?facing=${encodeURIComponent(facing)}`);
        // Adjuntamos la foto para que el modelo la VEA de una (no solo el path).
        let image: { mediaType: string; data: string } | undefined;
        try {
          image = await loadImageAsBase64(String(data.path));
        } catch {
          image = undefined; // si no se puede leer, al menos damos el path
        }
        return {
          name: 'phone.photo',
          command: `photo ${facing}`,
          status: 'success',
          output: image
            ? `Photo taken (${data.facing} camera), saved to ${data.path}. See the attached image.`
            : `Photo saved: ${data.path} (${data.bytes} bytes, ${data.facing} camera). Use image_view to look at it.`,
          image,
          cwd: context.cwd,
        };
      } catch (error: any) {
        return {
          name: 'phone.photo',
          command: `photo ${facing}`,
          status: 'error',
          output: error?.message ?? 'Could not take a photo.',
          cwd: context.cwd,
        };
      }
    }

    if (call.tool === 'image.view') {
      const targetPath = resolveTargetPath(String(call.arguments.path ?? ''), context.cwd);
      try {
        const image = await loadImageAsBase64(targetPath);
        return {
          name: 'image.view',
          command: targetPath,
          status: 'success',
          output: `Loaded image ${targetPath}. See the attached image.`,
          image,
          cwd: context.cwd,
        };
      } catch (error: any) {
        return {
          name: 'image.view',
          command: targetPath,
          status: 'error',
          output: error?.message ?? 'Could not load the image.',
          cwd: context.cwd,
        };
      }
    }

    throw new Error(`Unsupported tool: ${call.tool}`);
  };
}
