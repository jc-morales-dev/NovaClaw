/**
 * toolsSearch.ts — Búsqueda recursiva en el sistema de archivos del executor:
 *   - file.grep → busca contenido (regex) recorriendo el árbol, saltando dirs
 *     ruidosos y binarios, sin filtrar archivos con secretos.
 *   - file.search → busca por NOMBRE de archivo/carpeta.
 * Módulo solo-Node (fs); lo consume tools.ts vía executeSearchTool.
 */
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import type { ToolCallLike, ToolExecutionResult } from './types';
import { resolveTargetPath, isProtectedPath, type ToolExecutionContext } from './toolsFsHelpers';

/** Tools que este módulo atiende (nombres con punto, como los ve el executor). */
export const SEARCH_TOOLS = new Set(['file.grep', 'file.search']);

/** Ejecuta una tool de búsqueda. Se asume que SEARCH_TOOLS.has(call.tool). */
export async function executeSearchTool(
  call: ToolCallLike,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
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

  throw new Error(`Unsupported search tool: ${call.tool}`);
}
