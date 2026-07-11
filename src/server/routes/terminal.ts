import fs from 'node:fs';
import path from 'node:path';
import { exec as execCallback } from 'node:child_process';
import type { Express } from 'express';

import { DEFAULT_CWD } from '../config';
import { runtimeState } from '../state';

function isExistingDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function formatDirectoryEntries(targetPath: string): string {
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  if (entries.length === 0) {
    return '(empty)';
  }

  return entries
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .join('  ');
}

function resolveInstructionPath(rawPath: string, cwd: string): string {
  if (!rawPath) {
    return cwd;
  }

  if (rawPath === '~') {
    return DEFAULT_CWD;
  }

  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

export function registerTerminalRoutes(app: Express) {
  app.post('/api/terminal', (req, res) => {
    const { command, cwd } = req.body;
    const requestedCwd = typeof cwd === 'string' && cwd.trim() ? cwd : runtimeState.terminal.cwd;
    const currentCwd = isExistingDirectory(requestedCwd) ? requestedCwd : DEFAULT_CWD;
    const trimmedCmd = String(command ?? '').trim();
    // En Android hay un shell Linux real ($PREFIX/bin/sh vía SHELL). Cuando existe,
    // mandamos todo al shell nativo y saltamos los builtins JS (que rompen
    // pipes, flags y &&). Solo mantenemos cd/pwd/clear para el estado de la UI.
    const nativeShell = !!process.env.SHELL;

    runtimeState.terminal.cwd = currentCwd;

    if (!trimmedCmd) {
      return res.json({ output: '', cwd: currentCwd });
    }

    if (trimmedCmd === 'cls' || trimmedCmd === 'clear') {
      return res.json({ output: '__CLEAR__', cwd: currentCwd });
    }

    if (!nativeShell && trimmedCmd === 'date') {
      return res.json({ output: new Date().toString(), cwd: currentCwd });
    }

    if (!nativeShell && trimmedCmd === 'whoami') {
      return res.json({ output: process.env.USERNAME || process.env.USER || 'unknown', cwd: currentCwd });
    }

    if (trimmedCmd === 'pwd') {
      return res.json({ output: currentCwd, cwd: currentCwd });
    }

    if (!nativeShell && trimmedCmd === 'help') {
      return res.json({
        output: `Available built-in commands:
  cls, clear    - Clear terminal screen
  date          - Show current date and time
  whoami        - Show current user
  pwd           - Show current directory
  cd <path>     - Change current directory
  ls [path]     - List directory contents
  cat <file>    - Display file contents
  echo <text>   - Print text to terminal
  node -v       - Show Node.js version
  npm -v        - Show npm version
  python -V     - Show Python version
  <any>         - Execute as shell command`,
        cwd: currentCwd,
      });
    }

    if (!nativeShell && trimmedCmd.startsWith('echo ')) {
      return res.json({ output: trimmedCmd.substring(5), cwd: currentCwd });
    }

    if (trimmedCmd === 'cd' || trimmedCmd === 'cd ~') {
      runtimeState.terminal.cwd = DEFAULT_CWD;
      return res.json({ output: '', cwd: DEFAULT_CWD });
    }

    if (trimmedCmd === 'cd .') {
      return res.json({ output: '', cwd: currentCwd });
    }

    if (trimmedCmd.startsWith('cd ')) {
      const destination = trimmedCmd.substring(3).trim();
      const newCwd = resolveInstructionPath(destination, currentCwd);

      if (!isExistingDirectory(newCwd)) {
        return res.json({ output: `cd: directory not found: ${destination}`, cwd: currentCwd });
      }

      runtimeState.terminal.cwd = newCwd;
      return res.json({ output: '', cwd: newCwd });
    }

    if (!nativeShell && trimmedCmd === 'ls') {
      try {
        return res.json({ output: formatDirectoryEntries(currentCwd), cwd: currentCwd });
      } catch (error: any) {
        return res.json({ output: `ls: ${error.message}`, cwd: currentCwd });
      }
    }

    if (!nativeShell && trimmedCmd.startsWith('ls ')) {
      const targetPath = resolveInstructionPath(trimmedCmd.substring(3).trim(), currentCwd);
      try {
        return res.json({ output: formatDirectoryEntries(targetPath), cwd: currentCwd });
      } catch (error: any) {
        return res.json({ output: `ls: ${error.message}`, cwd: currentCwd });
      }
    }

    if (!nativeShell && trimmedCmd.startsWith('cat ')) {
      const filePath = resolveInstructionPath(trimmedCmd.substring(4).trim(), currentCwd);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        return res.json({ output: content, cwd: currentCwd });
      } catch (error: any) {
        return res.json({ output: `cat: ${error.message}`, cwd: currentCwd });
      }
    }

    execCallback(command, { cwd: currentCwd, timeout: 15000, shell: process.env.SHELL || undefined }, (error, stdout, stderr) => {
      let output = stdout || '';
      if (stderr) {
        output += stderr;
      }
      if (error && !stderr && !stdout) {
        output += error.message;
      }
      res.json({ output, cwd: currentCwd });
    });
  });
}
