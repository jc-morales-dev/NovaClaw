import type { ToolApprovalDecision, ToolCallLike } from './types';
import { basenamePath, normalizeComparablePath, resolvePortablePath } from './pathUtils';

type SafetyContext = {
  cwd: string;
  workspaceRoot: string;
};

// Comandos inherentemente destructivos o de alto impacto.
const SENSITIVE_COMMAND_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bdel\b/i,
  /\berase\b/i,
  /\bmv\b/i,
  /\bmove\b/i,
  /\bnpm\s+install\b/i,
  /\bpnpm\s+install\b/i,
  /\byarn\s+add\b/i,
  /\bpip\s+install\b/i,
  /\bapt(?:-get)?\s+install\b/i,
  /\bpkg\s+(?:install|add|uninstall|remove)\b/i,
  /\bapk\s+add\b/i,
  /\bpacman\s+-S\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bkill\b/i,
  /\bsudo\b/i,
  /\bsu\b\s+-/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  /\bfdisk\b/i,
  // Evasión común: ejecutar cualquier cosa vía shell invocando una sub-shell.
  /\bsh\s+-c\b/i,
  /\bbash\s+-c\b/i,
  /\bzsh\s+-c\b/i,
  /\beval\b/i,
  /\bexec\b/i,
  // Intérpretes con código inline: bypass clásico de la lista negra
  // (p.ej. `python -c "shutil.rmtree(...)"`, `node -e "fs.rmSync(...)"`).
  /\bpython[0-9.]*\s+-c\b/i,
  /\bnode\s+(?:-e|--eval)\b/i,
  /\bperl\s+-e\b/i,
  /\bruby\s+-e\b/i,
  /\bphp\s+-r\b/i,
  // Borrado/truncado que no usa `rm`.
  /\bfind\b[^\n]*\s-delete\b/i,
  /\bfind\b[^\n]*-exec\b/i,
  /\btruncate\b/i,
  /\bshred\b/i,
  /\bunlink\b/i,
  /\bgit\s+clean\b/i,
  // Escritura en el almacenamiento del teléfono o el home (borra/pisa datos del usuario).
  /\btee\b/i,
  /\bxargs\b/i,
  // Redirección que sobrescribe/append a archivos del sistema o del teléfono.
  />\s*\/(etc|bin|usr|var|boot|root|sdcard|storage|data)/i,
  />>\s*\/(etc|bin|usr|var|boot|root|sdcard|storage|data)/i,
  />\s*~\//,
  // Cambio de permisos/propietario recursivo o de apps del sistema.
  /\bpm\s+(uninstall|clear|disable)/i,
  /\bsettings\s+put\b/i,
];

// Archivos críticos dentro del workspace que NUNCA deben tocarse sin aprobación.
const CRITICAL_WORKSPACE_FILES = [
  'server.ts',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'vite.config.mjs',
  'vite.config.ts',
  '.env',
  '.env.local',
  '.env.production',
];

function normalizePath(value: string): string {
  return normalizeComparablePath(value);
}

function isWithinWorkspace(targetPath: string, workspaceRoot: string): boolean {
  const normalizedTarget = normalizePath(targetPath);
  const normalizedWorkspace = normalizePath(workspaceRoot);

  return normalizedTarget === normalizedWorkspace || normalizedTarget.startsWith(`${normalizedWorkspace}/`);
}

function isCriticalWorkspaceFile(targetPath: string, workspaceRoot: string): boolean {
  if (!isWithinWorkspace(targetPath, workspaceRoot)) return false;
  const basename = basenamePath(targetPath).toLowerCase();
  return CRITICAL_WORKSPACE_FILES.includes(basename);
}

function summarizeToolCall(call: ToolCallLike): string {
  return `${call.tool} ${JSON.stringify(call.arguments)}`;
}

function resolvePathArgument(rawPath: string, cwd: string): string {
  if (!rawPath) {
    return cwd;
  }

  if (rawPath.startsWith('/')) {
    return resolvePortablePath('/', rawPath);
  }

  return resolvePortablePath(cwd, rawPath);
}

export function classifyToolCall(call: ToolCallLike, context: SafetyContext): ToolApprovalDecision {
  if (call.tool === 'terminal.run') {
    const command = String(call.arguments.command ?? '').trim();
    const isSensitive = SENSITIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));

    return {
      requiresApproval: isSensitive,
      reason: isSensitive
        ? 'Sensitive shell command detected. User approval is required before execution.'
        : 'Read-only or low-risk shell command.',
      summary: summarizeToolCall(call),
    };
  }

  if (call.tool === 'file.write' || call.tool === 'file.edit') {
    const targetPath = resolvePathArgument(String(call.arguments.path ?? ''), context.cwd);
    const outsideWorkspace = !isWithinWorkspace(targetPath, context.workspaceRoot);
    const criticalFile = isCriticalWorkspaceFile(targetPath, context.workspaceRoot);
    const requiresApproval = outsideWorkspace || criticalFile;

    return {
      requiresApproval,
      reason: outsideWorkspace
        ? 'Sensitive file write detected outside the workspace root.'
        : criticalFile
          ? 'Attempt to modify a critical workspace file (config, lockfile, server or env).'
          : 'Workspace file write is allowed without confirmation.',
      summary: summarizeToolCall(call),
    };
  }

  if (call.tool === 'workspace.mkdir') {
    const targetPath = resolvePathArgument(String(call.arguments.path ?? ''), context.cwd);
    const outsideWorkspace = !isWithinWorkspace(targetPath, context.workspaceRoot);

    return {
      requiresApproval: outsideWorkspace,
      reason: outsideWorkspace
        ? 'Directory creation outside the workspace root requires approval.'
        : 'Workspace directory creation is allowed without confirmation.',
      summary: summarizeToolCall(call),
    };
  }

  return {
    requiresApproval: false,
    reason: 'Tool is treated as safe by the current policy.',
    summary: summarizeToolCall(call),
  };
}
