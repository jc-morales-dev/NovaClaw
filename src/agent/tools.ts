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
      const MAX_READ_BYTES = 256 * 1024; // 256 KB hard cap to protect the agent context window.
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
      const truncated = fullContent.length > MAX_READ_BYTES;
      const content = truncated
        ? `${fullContent.slice(0, MAX_READ_BYTES)}\n\n[... truncated, file is ${fullContent.length} bytes, showing first ${MAX_READ_BYTES} bytes ...]`
        : fullContent;

      return {
        name: 'file.read',
        command: targetPath,
        status: 'success',
        output: content,
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

    throw new Error(`Unsupported tool: ${call.tool}`);
  };
}
