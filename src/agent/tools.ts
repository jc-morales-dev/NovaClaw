import { exec as execCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ToolCallLike, ToolExecutionResult } from './types';
import { runDiagnostics } from './diagnostics';
import {
  MAX_READ_BYTES,
  MAX_READ_LINES,
  applyStringEdit,
  applyMultiEdit,
  formatWithLineNumbers,
  htmlToReadableText,
  isBlockedFetchHost,
  truncateFetchBody,
} from './toolShared';
import { resolveTargetPath, isProtectedPath, type ToolExecutionContext } from './toolsFsHelpers';
import { PHONE_TOOLS, executePhoneTool } from './toolsPhone';
import { SEARCH_TOOLS, executeSearchTool } from './toolsSearch';
import { performWebSearch, formatSearchResults } from './webSearch';
import { performDeepResearch, buildResearchDigest } from './deepResearch';

const exec = promisify(execCallback);

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

/** Cambio de archivo para el journal de "deshacer". */
export type FileChange = { path: string; before: string | null; existedBefore: boolean };

/** Control de servidores MCP para que el AGENTE pueda instalar/quitar tools solo. */
export type McpControls = {
  list: () => { configured: Record<string, { command: string; args?: string[] }>; connected: Array<{ name: string; server: string }> };
  add: (name: string, command: string, args: string[], env?: Record<string, string>) => Promise<{ connected: string[]; failed: Array<{ name: string; error: string }> }>;
  remove: (name: string) => Promise<{ connected: string[]; failed: Array<{ name: string; error: string }> }>;
};

export function createLocalToolExecutor(
  opts: {
    onFileChange?: (change: FileChange) => void;
    mcp?: McpControls;
    // B7: se llama tras una mutación exitosa; su salida se anexa al resultado.
    onAfterMutation?: (info: { tool: string; path: string; cwd: string }) => Promise<string | null>;
  } = {},
) {
  const executeToolCall = async function (
    call: ToolCallLike,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    // Delegación por concern: teléfono/visión y búsqueda recursiva viven en
    // módulos aparte para mantener este executor enfocado en fs/terminal/mcp.
    if (PHONE_TOOLS.has(call.tool)) return executePhoneTool(call, context);
    if (SEARCH_TOOLS.has(call.tool)) return executeSearchTool(call, context);

    if (call.tool === 'terminal.run') {
      return runTerminalCommand(String(call.arguments.command ?? ''), context.cwd);
    }

    if (call.tool === 'diagnostics.check') {
      const targetPath = resolveTargetPath(String(call.arguments.path ?? ''), context.cwd);
      try {
        const r = await runDiagnostics(targetPath, context.cwd);
        return {
          name: 'diagnostics.check',
          command: `${r.tool} · ${path.basename(targetPath)}`,
          status: r.ok ? 'success' : 'error',
          output: r.output,
          cwd: context.cwd,
        };
      } catch (error: any) {
        return {
          name: 'diagnostics.check',
          command: targetPath,
          status: 'error',
          output: error?.message ?? 'No se pudieron obtener diagnósticos.',
          cwd: context.cwd,
        };
      }
    }

    // ── Gestión de servidores MCP por el agente ("instalá el MCP de X") ────────
    if (call.tool === 'mcp.list') {
      if (!opts.mcp) return { name: 'mcp.list', command: 'list', status: 'error', output: 'MCP no disponible en este runtime.', cwd: context.cwd };
      const { configured, connected } = opts.mcp.list();
      const names = Object.keys(configured);
      const lines = names.length
        ? names.map((n) => `- ${n}: ${configured[n].command} ${(configured[n].args ?? []).join(' ')}`).join('\n')
        : '(ningún servidor MCP configurado)';
      return { name: 'mcp.list', command: 'list', status: 'success', output: `Servidores MCP:\n${lines}\n\nTools conectadas: ${connected.length}`, cwd: context.cwd };
    }

    if (call.tool === 'mcp.add') {
      if (!opts.mcp) return { name: 'mcp.add', command: 'add', status: 'error', output: 'MCP no disponible en este runtime.', cwd: context.cwd };
      const name = String(call.arguments.name ?? '').trim();
      const command = String(call.arguments.command ?? '').trim();
      const args = Array.isArray(call.arguments.args) ? call.arguments.args.map((a: any) => String(a)) : [];
      const env = (call.arguments.env && typeof call.arguments.env === 'object') ? (call.arguments.env as Record<string, string>) : undefined;
      if (!name || !command) return { name: 'mcp.add', command: `${name}`, status: 'error', output: 'Faltan "name" o "command".', cwd: context.cwd };
      try {
        const r = await opts.mcp.add(name, command, args, env);
        const ok = r.connected.includes(name);
        const fail = r.failed.find((f) => f.name === name);
        return {
          name: 'mcp.add',
          command: `${name}: ${command} ${args.join(' ')}`.trim(),
          status: ok ? 'success' : 'error',
          output: ok
            ? `MCP "${name}" instalado y conectado. Ahora tenés sus herramientas disponibles.`
            : `No se pudo conectar "${name}": ${fail?.error ?? 'error desconocido'}.`,
          cwd: context.cwd,
        };
      } catch (error: any) {
        return { name: 'mcp.add', command: name, status: 'error', output: error?.message ?? 'No se pudo agregar el MCP.', cwd: context.cwd };
      }
    }

    if (call.tool === 'mcp.remove') {
      if (!opts.mcp) return { name: 'mcp.remove', command: 'remove', status: 'error', output: 'MCP no disponible en este runtime.', cwd: context.cwd };
      const name = String(call.arguments.name ?? '').trim();
      if (!name) return { name: 'mcp.remove', command: '', status: 'error', output: 'Falta "name".', cwd: context.cwd };
      try {
        await opts.mcp.remove(name);
        return { name: 'mcp.remove', command: name, status: 'success', output: `MCP "${name}" quitado.`, cwd: context.cwd };
      } catch (error: any) {
        return { name: 'mcp.remove', command: name, status: 'error', output: error?.message ?? 'No se pudo quitar el MCP.', cwd: context.cwd };
      }
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
      const output = formatWithLineNumbers(fullContent, call.arguments, MAX_READ_LINES, MAX_READ_BYTES);

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
      // Snapshot para deshacer: contenido previo (o marca de que no existía).
      let before: string | null = null;
      let existedBefore = false;
      try { before = await fs.readFile(targetPath, 'utf8'); existedBefore = true; } catch { before = null; existedBefore = false; }
      opts.onFileChange?.({ path: targetPath, before, existedBefore });
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

      const edit = applyStringEdit(content, oldString, newString, replaceAll);
      if (!edit.ok) {
        return {
          name: 'file.edit',
          command: targetPath,
          status: 'error',
          output: edit.error,
          cwd: context.cwd,
        };
      }
      opts.onFileChange?.({ path: targetPath, before: content, existedBefore: true });
      await fs.writeFile(targetPath, edit.updated, 'utf8');

      return {
        name: 'file.edit',
        command: targetPath,
        status: 'success',
        output: `Edited ${targetPath}: replaced ${edit.replacedCount} occurrence${edit.replacedCount === 1 ? '' : 's'}.`,
        cwd: context.cwd,
      };
    }

    if (call.tool === 'file.edit_multi') {
      const targetPath = resolveTargetPath(String(call.arguments.path ?? ''), context.cwd);
      const edits = Array.isArray(call.arguments.edits) ? call.arguments.edits : [];

      let content: string;
      try {
        content = await fs.readFile(targetPath, 'utf8');
      } catch {
        return {
          name: 'file.edit_multi',
          command: targetPath,
          status: 'error',
          output: `File not found: ${targetPath}. Use file_write to create new files.`,
          cwd: context.cwd,
        };
      }

      const edit = applyMultiEdit(content, edits);
      if (!edit.ok) {
        return {
          name: 'file.edit_multi',
          command: targetPath,
          status: 'error',
          output: edit.error,
          cwd: context.cwd,
        };
      }
      opts.onFileChange?.({ path: targetPath, before: content, existedBefore: true });
      await fs.writeFile(targetPath, edit.updated, 'utf8');

      return {
        name: 'file.edit_multi',
        command: targetPath,
        status: 'success',
        output: `Edited ${targetPath}: ${edits.length} edits, ${edit.replacedCount} replacement${edit.replacedCount === 1 ? '' : 's'}.`,
        cwd: context.cwd,
      };
    }

    if (call.tool === 'web.search') {
      const query = String(call.arguments.query ?? '').trim();
      if (!query) {
        return {
          name: 'web.search',
          command: '',
          status: 'error',
          output: 'Provide a search query (query).',
          cwd: context.cwd,
        };
      }
      const maxResults = Number(call.arguments.max_results) || 8;
      try {
        const results = await performWebSearch(query, maxResults);
        return {
          name: 'web.search',
          command: query,
          status: 'success',
          output: formatSearchResults(query, results),
          cwd: context.cwd,
        };
      } catch (error: any) {
        return {
          name: 'web.search',
          command: query,
          status: 'error',
          output: `Search failed: ${error?.message ?? 'network error'}. Check the connection or try web_fetch on a known URL.`,
          cwd: context.cwd,
        };
      }
    }

    if (call.tool === 'deep.research') {
      const query = String(call.arguments.query ?? '').trim();
      if (!query) {
        return {
          name: 'deep.research',
          command: '',
          status: 'error',
          output: 'Provide a research question (query).',
          cwd: context.cwd,
        };
      }
      const maxSources = Number(call.arguments.max_sources) || 4;
      try {
        const { sources } = await performDeepResearch(query, { maxSources });
        return {
          name: 'deep.research',
          command: query,
          status: 'success',
          output: buildResearchDigest(query, sources),
          cwd: context.cwd,
        };
      } catch (error: any) {
        return {
          name: 'deep.research',
          command: query,
          status: 'error',
          output: `Research failed: ${error?.message ?? 'network error'}. Try web_search + web_fetch manually.`,
          cwd: context.cwd,
        };
      }
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
          body = htmlToReadableText(body);
        }
        body = truncateFetchBody(body);
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

    throw new Error(`Unsupported tool: ${call.tool}`);
  };

  // B7: sin hooks configurados, devolvemos el executor tal cual.
  if (!opts.onAfterMutation) return executeToolCall;

  // Con hooks: tras una MUTACIÓN exitosa, corremos los PostToolUse y anexamos su
  // salida al resultado (formateo/lint pasan sin que el modelo tenga que pedirlo).
  const MUTATION_TOOLS = new Set(['file.write', 'file.edit', 'file.edit_multi']);
  return async function executeWithHooks(
    call: ToolCallLike,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const result = await executeToolCall(call, context);
    if (result.status === 'success' && MUTATION_TOOLS.has(call.tool)) {
      try {
        const note = await opts.onAfterMutation!({
          tool: call.tool,
          path: resolveTargetPath(String(call.arguments.path ?? ''), context.cwd),
          cwd: context.cwd,
        });
        if (note) return { ...result, output: `${result.output}\n${note}` };
      } catch {
        // un hook roto nunca debe romper la ejecución de la tool
      }
    }
    return result;
  };
}
