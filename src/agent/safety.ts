import type { ToolApprovalDecision, ToolCallLike } from './types';
import { basenamePath, normalizeComparablePath, resolvePortablePath } from './pathUtils';

type SafetyContext = {
  cwd: string;
  workspaceRoot: string;
};

// ============================================================================
// Modelo ALLOWLIST (default-deny) para terminal.run
//
// Antes era una lista negra de comandos peligrosos; las blacklists nunca son
// completas (busybox rm, cp /dev/null, install, ln -sf, …). Ahora el modelo
// es al revés: un comando corre sin aprobación SOLO si cada segmento del
// pipeline empieza con un binario verificado como de lectura/bajo riesgo y
// la línea no contiene constructos que ejecuten o escriban por otra vía
// (sustitución de comandos, redirecciones de escritura, env vars de inyección).
// Todo lo demás — incluido lo que no reconocemos — pide aprobación al usuario.
// ============================================================================

// Binarios seguros con cualquier argumento (lectura pura / diagnóstico).
const SAFE_ANY_ARGS = new Set([
  // Archivos: lectura y navegación
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'df', 'tree',
  'realpath', 'readlink', 'basename', 'dirname', 'which', 'whereis',
  'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'xxd', 'od', 'strings',
  'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'column', 'nl', 'tac', 'rev',
  'paste', 'join', 'comm', 'fold',
  // Búsqueda de contenido
  'grep', 'egrep', 'fgrep', 'rg', 'zgrep',
  // Sistema / entorno (lectura)
  'echo', 'printf', 'date', 'cal', 'uptime', 'whoami', 'id', 'groups', 'uname',
  'hostname', 'nproc', 'free', 'ps', 'printenv', 'locale', 'tty',
  'getprop', 'dumpsys',
  // Utilidades inofensivas
  'sleep', 'true', 'false', 'test', 'expr', 'seq', 'jq', 'base64', 'hexdump',
  // Dev tools que solo leen o escriben dentro del workspace (build/lint/test)
  'tsc', 'vitest', 'jest', 'eslint', 'prettier',
]);

// Wrappers que ejecutan otro comando: se saltan sus flags y se analiza el
// comando envuelto de forma recursiva (env FOO=1 node x.js → analizar node…).
const WRAPPER_BINARIES = new Set(['env', 'nice', 'nohup', 'time', 'timeout', 'stdbuf', 'command']);

// Asignaciones de entorno que permiten inyectar código en procesos hijos.
const DANGEROUS_ENV_EXACT = new Set([
  'PATH', 'IFS', 'ENV', 'BASH_ENV', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONSTARTUP',
  'PYTHONHOME', 'PAGER', 'GIT_PAGER', 'PROMPT_COMMAND', 'PERL5LIB', 'RUBYLIB',
  'RUBYOPT', 'SHELL',
]);
const DANGEROUS_ENV_PREFIXES = ['LD_', 'DYLD_', 'GIT_SSH'];

// Subcomandos git de solo lectura con cualquier argumento.
const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'shortlog', 'describe', 'rev-parse',
  'ls-files', 'ls-tree', 'cat-file', 'reflog', 'count-objects', 'rev-list',
  'grep', 'var', 'whatchanged', 'cherry', 'merge-base',
]);

// Subcomandos npm/pnpm/yarn permitidos (test/run ejecutan código DEL workspace,
// que es el caso de uso del agente; install/publish/etc. piden aprobación).
const NPM_SAFE_SUBCOMMANDS = new Set([
  'test', 't', 'run', 'run-script', 'ls', 'list', 'view', 'info', 'show',
  'outdated', 'ping', 'help', 'root', 'prefix', 'why', '--version', '-v', 'version',
]);

type SegmentValidator = (args: string[]) => boolean;

const hasAnyFlag = (args: string[], banned: string[]): boolean =>
  args.some((arg) => banned.includes(arg));

// Binarios seguros solo si sus argumentos pasan el validador.
const SAFE_WITH_VALIDATOR: Record<string, SegmentValidator> = {
  find: (args) =>
    !args.some((arg) =>
      ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(arg),
    ),
  git: (args) => {
    const sub = args.find((arg) => !arg.startsWith('-'));
    if (!sub) return true; // `git --version`, `git` a secas
    if (GIT_READ_SUBCOMMANDS.has(sub)) return true;
    const rest = args.slice(args.indexOf(sub) + 1);
    if (sub === 'branch') {
      return !hasAnyFlag(rest, ['-d', '-D', '-m', '-M', '-c', '-C', '-f', '--force', '--delete', '--move', '--copy']) &&
        !rest.some((a) => a.startsWith('--set-upstream'));
    }
    if (sub === 'tag') {
      // Solo listar: sin args, o únicamente flags de listado.
      return rest.every((a) => a === '-l' || a === '--list' || a.startsWith('-n') || a === '--sort' || a.startsWith('--sort='));
    }
    if (sub === 'remote') {
      return rest.length === 0 || rest[0] === '-v' || rest[0] === 'show' || rest[0] === 'get-url';
    }
    if (sub === 'config') {
      return rest.some((a) => a === '--get' || a === '--get-all' || a === '--list' || a === '-l');
    }
    if (sub === 'stash') {
      return rest[0] === 'list' || rest[0] === 'show';
    }
    return false; // push, pull, checkout, reset, clean, commit, … → aprobación
  },
  node: (args) => !hasAnyFlag(args, ['-e', '--eval', '-p', '--print']),
  tsx: (args) => !hasAnyFlag(args, ['-e', '--eval', '-p', '--print']),
  'ts-node': (args) => !hasAnyFlag(args, ['-e', '--eval', '-p', '--print']),
  deno: (args) => args[0] === 'lint' || args[0] === 'check' || args[0] === 'fmt',
  python: pythonValidator(),
  python2: pythonValidator(),
  python3: pythonValidator(),
  npm: npmValidator(),
  pnpm: npmValidator(),
  yarn: npmValidator(),
  pip: (args) => ['list', 'show', 'freeze', 'check', 'debug', 'help'].includes(args[0] ?? ''),
  pip3: (args) => ['list', 'show', 'freeze', 'check', 'debug', 'help'].includes(args[0] ?? ''),
  pm: (args) => ['list', 'path', 'dump'].includes(args[0] ?? ''),
  settings: (args) => ['get', 'list'].includes(args[0] ?? ''),
};

function pythonValidator(): SegmentValidator {
  // Sin código inline (-c) ni módulos (-m: pip/ensurepip/http.server…).
  return (args) => !hasAnyFlag(args, ['-c', '-m']);
}

function npmValidator(): SegmentValidator {
  return (args) => {
    const sub = args.find((arg) => !arg.startsWith('-')) ?? args[0];
    return sub !== undefined && NPM_SAFE_SUBCOMMANDS.has(sub);
  };
}

export type ShellAnalysis = {
  safe: boolean;
  detail: string;
};

// ── Escáner de la línea completa ────────────────────────────────────────────
// Un solo pase char a char con estado de comillas. Detecta sustitución de
// comandos, corta la línea en segmentos por operadores, y valida redirecciones.

type LineScan = {
  segments: string[];
  unsafeDetail: string | null;
};

function scanCommandLine(command: string): LineScan {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  const pushSegment = () => {
    if (current.trim().length > 0) segments.push(current.trim());
    current = '';
  };

  while (i < command.length) {
    const ch = command[i];
    const next = command[i + 1];

    if (inSingle) {
      if (ch === "'") inSingle = false;
      current += ch;
      i += 1;
      continue;
    }

    // Fuera de comillas simples: backticks y $( ) se expanden (también dentro
    // de comillas dobles) → ejecución arbitraria escondida.
    if (ch === '`') return { segments, unsafeDetail: 'command substitution (backticks)' };
    if (ch === '$' && next === '(') return { segments, unsafeDetail: 'command substitution $( )' };

    if (ch === '\\') {
      current += ch + (next ?? '');
      i += 2;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = true;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = !inDouble;
      current += ch;
      i += 1;
      continue;
    }
    if (inDouble) {
      current += ch;
      i += 1;
      continue;
    }

    // Operadores de control fuera de comillas → cortar segmento.
    if (ch === '&' && next === '&') { pushSegment(); i += 2; continue; }
    if (ch === '|' && next === '|') { pushSegment(); i += 2; continue; }
    if (ch === '|') { pushSegment(); i += 1; continue; }
    if (ch === ';' || ch === '\n') { pushSegment(); i += 1; continue; }

    // Redirecciones. Solo se permite silenciar output (→ /dev/null, 2>&1).
    if (ch === '>' || (ch === '&' && next === '>')) {
      // Quitar el fd previo pegado al buffer (p.ej. el "2" de `2>`).
      current = current.replace(/(^|\s)\d$/, '$1');
      let j = ch === '&' ? i + 2 : i + 1; // `&>` consume dos chars
      if (command[j] === '>') j += 1; // `>>`
      if (command[j] === '&') {
        // `>&1`, `2>&1`, `>&2` — duplicar fd, inofensivo.
        j += 1;
        while (j < command.length && /\d/.test(command[j])) j += 1;
        i = j;
        continue;
      }
      while (j < command.length && command[j] === ' ') j += 1;
      let target = '';
      while (j < command.length && !/[\s;|&<>]/.test(command[j])) {
        target += command[j];
        j += 1;
      }
      const cleanTarget = target.replace(/^['"]|['"]$/g, '');
      if (cleanTarget !== '/dev/null') {
        return { segments, unsafeDetail: `write redirection to '${cleanTarget || '?'}'` };
      }
      i = j;
      continue;
    }
    if (ch === '&') { pushSegment(); i += 1; continue; } // background

    if (ch === '<') {
      // Lectura de stdin (`<`, `<<`, `<<<`): no escribe nada. Consumir el token.
      let j = i + 1;
      while (command[j] === '<') j += 1;
      while (j < command.length && command[j] === ' ') j += 1;
      while (j < command.length && !/[\s;|&<>]/.test(command[j])) j += 1;
      i = j;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (inSingle || inDouble) {
    return { segments, unsafeDetail: 'unterminated quote' };
  }
  pushSegment();
  return { segments, unsafeDetail: null };
}

// ── Tokenización y análisis por segmento ────────────────────────────────────

function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (inSingle) {
      if (ch === "'") { inSingle = false; continue; }
      current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') { inDouble = false; continue; }
      current += ch;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '\\' && i + 1 < segment.length) { current += segment[i + 1]; i += 1; continue; }
    if (/\s/.test(ch)) {
      if (current.length > 0) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function isDangerousEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (DANGEROUS_ENV_EXACT.has(upper)) return true;
  return DANGEROUS_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_WRAPPER_DEPTH = 4;

function analyzeTokens(tokens: string[], depth: number): ShellAnalysis {
  // Saltar asignaciones de entorno iniciales (NODE_ENV=test npm test).
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index])) {
    const name = tokens[index].slice(0, tokens[index].indexOf('='));
    if (isDangerousEnvName(name)) {
      return { safe: false, detail: `dangerous env assignment '${name}'` };
    }
    index += 1;
  }

  if (index >= tokens.length) return { safe: true, detail: 'empty command' };

  const binaryToken = tokens[index];
  const args = tokens.slice(index + 1);

  // Binarios con ruta (absoluta o relativa) no son verificables por nombre.
  if (binaryToken.includes('/') || binaryToken.includes('\\')) {
    return { safe: false, detail: `unverifiable binary path '${binaryToken}'` };
  }
  const binary = binaryToken.toLowerCase();

  if (WRAPPER_BINARIES.has(binary)) {
    if (depth >= MAX_WRAPPER_DEPTH) return { safe: false, detail: 'wrapper nesting too deep' };
    return analyzeWrappedCommand(binary, args, depth);
  }

  // Versiones con sufijo: python3.11 → python3.
  const normalized = binary.replace(/^python[0-9.]+$/, 'python3');

  if (SAFE_ANY_ARGS.has(normalized)) return { safe: true, detail: `allowlisted '${normalized}'` };

  const validator = SAFE_WITH_VALIDATOR[normalized];
  if (validator) {
    return validator(args)
      ? { safe: true, detail: `allowlisted '${normalized}' (validated args)` }
      : { safe: false, detail: `mutating or inline-code use of '${normalized}'` };
  }

  return { safe: false, detail: `unrecognized binary '${binary}'` };
}

function analyzeWrappedCommand(wrapper: string, args: string[], depth: number): ShellAnalysis {
  let rest = [...args];
  if (wrapper === 'env') {
    // Saltar flags (-i, -u NAME, --unset=NAME) y asignaciones; validar estas últimas.
    while (rest.length > 0) {
      const tok = rest[0];
      if (tok === '-u' || tok === '--unset') { rest = rest.slice(2); continue; }
      if (tok.startsWith('-')) { rest = rest.slice(1); continue; }
      if (ENV_ASSIGNMENT.test(tok)) {
        const name = tok.slice(0, tok.indexOf('='));
        if (isDangerousEnvName(name)) return { safe: false, detail: `dangerous env assignment '${name}'` };
        rest = rest.slice(1);
        continue;
      }
      break;
    }
  } else if (wrapper === 'timeout') {
    // timeout [flags] DURATION cmd…
    while (rest.length > 0 && rest[0].startsWith('-')) {
      const tok = rest[0];
      rest = rest.slice(tok === '-s' || tok === '--signal' || tok === '-k' || tok === '--kill-after' ? 2 : 1);
    }
    rest = rest.slice(1); // la duración
  } else if (wrapper === 'command') {
    // Solo permitimos `command -v/-V binario` (equivalente a which).
    return rest[0] === '-v' || rest[0] === '-V'
      ? { safe: true, detail: 'command -v lookup' }
      : { safe: false, detail: 'command wrapper executes arbitrary binaries' };
  } else {
    // nice/nohup/time/stdbuf: saltar flags simples (con posible valor pegado).
    while (rest.length > 0 && rest[0].startsWith('-')) {
      const tok = rest[0];
      rest = rest.slice(tok === '-n' && wrapper === 'nice' ? 2 : 1);
    }
  }
  if (rest.length === 0) return { safe: true, detail: `bare '${wrapper}'` };
  return analyzeTokens(rest, depth + 1);
}

/**
 * Analiza una línea de shell completa bajo el modelo allowlist.
 * safe=true solo si TODOS los segmentos del pipeline son verificables.
 */
export function analyzeShellCommand(command: string): ShellAnalysis {
  const trimmed = command.trim();
  if (trimmed.length === 0) return { safe: true, detail: 'empty command' };

  const scan = scanCommandLine(trimmed);
  if (scan.unsafeDetail) return { safe: false, detail: scan.unsafeDetail };

  for (const segment of scan.segments) {
    const result = analyzeTokens(tokenizeSegment(segment), 0);
    if (!result.safe) return result;
  }
  return { safe: true, detail: 'all segments allowlisted' };
}

// ── Política de archivos (sin cambios de modelo) ────────────────────────────

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
  // Config que puede ejecutar comandos: escribirla exige aprobación del usuario
  // (así el agente no puede auto-instalar un hook/MCP malicioso en silencio).
  'novaclaw.hooks.json',
  'novaclaw.mcp.json',
  'novaclaw.config.json',
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
    const analysis = analyzeShellCommand(command);

    return {
      requiresApproval: !analysis.safe,
      reason: analysis.safe
        ? `Read-only or low-risk shell command (${analysis.detail}).`
        : `Sensitive or unverified shell command (${analysis.detail}). ` +
          'Default-deny policy: user approval is required before execution.',
      summary: summarizeToolCall(call),
    };
  }

  if (call.tool === 'file.write' || call.tool === 'file.edit' || call.tool === 'file.edit_multi') {
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
