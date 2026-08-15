/**
 * Motor de diagnósticos: le da "ojos" al agente. Tras editar un archivo, corre el
 * type-checker/linter real del lenguaje (tsc, ruff, eslint, node --check, go vet…)
 * y devuelve los errores del compilador — así el agente ve sus errores de verdad
 * en vez de adivinar. Es la pieza que acerca el agente al nivel de OpenCode (LSP).
 *
 * Nunca auto-instala herramientas (no usa `npx <pkg>` que descargaría): si el
 * chequeador no está, lo dice y sugiere cómo instalarlo.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

// SIN shell, y con los argumentos en un array.
//
// Antes esto armaba la línea interpolando la ruta (`node --check "${filePath}"`)
// y la corría con el shell del sistema. Como la ruta la elige el modelo y el
// agente puede crear archivos sin aprobación, un archivo llamado
// `script$(comando).js` ejecutaba `comando` al pedirle diagnósticos: el shell
// expande $( ) dentro de las comillas dobles, y lo hace antes incluso de buscar
// el binario, así que ni hacía falta que node estuviera instalado.
const execFile = promisify(execFileCallback);

async function has(bin: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [bin] : ['-v', bin];
  try {
    // `command -v` es un builtin: sin shell no existe como binario. En POSIX se
    // resuelve preguntándole a `sh` con el nombre como ARGUMENTO (no concatenado),
    // que es seguro: sh -c 'command -v "$1"' _ <bin>.
    if (process.platform !== 'win32') {
      await execFile('sh', ['-c', 'command -v "$1"', '_', bin], { timeout: 5000 });
      return true;
    }
    await execFile(probe, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function runCmd(bin: string, args: string[], cwd: string, timeoutMs = 30000): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFile(bin, args, { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
    return { code: 0, out: `${stdout ?? ''}${stderr ?? ''}`.trim() };
  } catch (error: any) {
    const out = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim();
    return { code: typeof error?.code === 'number' ? error.code : 1, out: out || error?.message || 'error' };
  }
}

/** Busca un archivo subiendo directorios (hasta 8 niveles). Devuelve su ruta o null. */
function findUp(startDir: string, name: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Comando listo para execFile: binario + argumentos que van ANTES de los propios. */
type BinEntry = { cmd: string; pre: string[] };

/**
 * Saca del shim de npm la ruta del .js real.
 *
 * El shim de `node_modules/.bin/x` es un script sh que termina en
 * `exec node "$basedir/../<paquete>/bin/x" "$@"`. En POSIX se ejecuta solo (tiene
 * shebang), pero en Windows no es un ejecutable y execFile falla con ENOENT.
 * Como el destino siempre es un .js, lo lanzamos con el propio Node en vez de
 * volver al shell para interpretar el .cmd.
 */
function jsEntryFromShim(shimPath: string): string | null {
  try {
    const texto = fs.readFileSync(shimPath, 'utf8');
    // La primera cita es `"$basedir/node"` (sin barra); la buena lleva ruta.
    const rutas = [...texto.matchAll(/"\$basedir\/([^"]+)"/g)].map((m) => m[1]);
    const relativa = rutas.find((r) => r.includes('/'));
    if (!relativa) return null;
    const destino = path.resolve(path.dirname(shimPath), relativa);
    return fs.existsSync(destino) ? destino : null;
  } catch {
    return null;
  }
}

/** Resuelve el .js real de un shim `.cmd` generado por npm en Windows. */
function jsEntryFromCmdShim(shimPath: string): string | null {
  try {
    const texto = fs.readFileSync(shimPath, 'utf8');
    const rutas = [...texto.matchAll(/"%dp0%\\([^"%]+)"/gi)].map((m) => m[1]);
    const relativa = rutas.find((r) => /[\\/]/.test(r) && !/node\.exe$/i.test(r));
    if (!relativa) return null;
    const destino = path.resolve(path.dirname(shimPath), relativa.replace(/[\\/]+/g, path.sep));
    return fs.existsSync(destino) ? destino : null;
  } catch {
    return null;
  }
}

async function resolveGlobalBin(bin: string): Promise<BinEntry | null> {
  if (process.platform !== 'win32') {
    return await has(bin) ? { cmd: bin, pre: [] } : null;
  }
  try {
    const whereExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
    const { stdout } = await execFile(whereExe, [bin], { timeout: 5000 });
    const candidates = String(stdout ?? '').split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
    for (const candidate of candidates) {
      const ext = path.extname(candidate).toLowerCase();
      if (ext === '.exe' || ext === '.com') return { cmd: candidate, pre: [] };
      const js = ext === '.cmd' ? jsEntryFromCmdShim(candidate) : jsEntryFromShim(candidate);
      if (js) return { cmd: process.execPath, pre: [js] };
    }
  } catch {
    // no está en PATH
  }
  return null;
}

/** Resuelve un binario de node_modules/.bin del proyecto, o global, o null (sin auto-instalar). */
async function resolveBin(projectDir: string, bin: string): Promise<BinEntry | null> {
  const local = path.join(projectDir, 'node_modules', '.bin', bin);
  if (fs.existsSync(local)) {
    if (process.platform === 'win32') {
      const js = jsEntryFromShim(local);
      if (js) return { cmd: process.execPath, pre: [js] };
    } else {
      return { cmd: local, pre: [] };
    }
  }
  return resolveGlobalBin(bin);
}

export type DiagResult = { tool: string; ok: boolean; output: string };

const OK = (tool: string, output: string): DiagResult => ({ tool, ok: true, output });
const BAD = (tool: string, output: string): DiagResult => ({ tool, ok: false, output });

/** Corre el mejor chequeador disponible para el archivo y devuelve los diagnósticos. */
export async function runDiagnostics(filePath: string, cwd: string): Promise<DiagResult> {
  const ext = path.extname(filePath).toLowerCase();
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);

  if (!fs.existsSync(filePath)) return BAD('none', `Archivo no encontrado: ${filePath}`);

  // ── JSON ──────────────────────────────────────────────────────────────────
  if (ext === '.json') {
    try {
      JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return OK('json', 'JSON válido.');
    } catch (error: any) {
      return BAD('json', `JSON inválido: ${error?.message}`);
    }
  }

  // ── Python ──────────────────────────────────────────────────────────────────
  if (ext === '.py') {
    if (await has('ruff')) {
      const r = await runCmd('ruff', ['check', filePath], cwd);
      return r.code === 0 ? OK('ruff', 'Sin problemas.') : BAD('ruff', r.out.slice(0, 6000));
    }
    if (await has('pyflakes')) {
      const r = await runCmd('pyflakes', [filePath], cwd);
      return r.code === 0 ? OK('pyflakes', 'Sin problemas.') : BAD('pyflakes', r.out.slice(0, 6000));
    }
    const py = (await has('python')) ? 'python' : (await has('python3') ? 'python3' : null);
    if (py) {
      const r = await runCmd(py, ['-I', '-m', 'py_compile', filePath], cwd);
      return r.code === 0 ? OK('py_compile', 'Sintaxis OK.') : BAD('py_compile', r.out.slice(0, 6000));
    }
    return OK('none', 'No hay chequeador de Python (ruff/pyflakes/python). Instalá ruff: pip install ruff');
  }

  // ── TypeScript (tipos reales con tsc del proyecto) ──────────────────────────
  if (ext === '.ts' || ext === '.tsx') {
    const tsconfig = findUp(dir, 'tsconfig.json');
    if (!tsconfig) return OK('none', 'No hay tsconfig.json; no se puede chequear tipos de TS.');
    const proj = path.dirname(tsconfig);
    const tsc = await resolveBin(proj, 'tsc');
    if (!tsc) return OK('none', 'tsc no está instalado. Instalalo: npm i -g typescript (o en el proyecto).');
    const r = await runCmd(tsc.cmd, [...tsc.pre, '--noEmit', '--pretty', 'false', '-p', tsconfig], proj, 120000);
    if (r.code === 0) return OK('tsc', 'Sin errores de tipos.');
    // Enfocar a los errores del archivo editado para no abrumar el contexto.
    const focused = r.out.split('\n').filter((l) => l.includes(base)).join('\n');
    return BAD('tsc', (focused || r.out).slice(0, 6000));
  }

  // ── JavaScript ──────────────────────────────────────────────────────────────
  if (['.js', '.mjs', '.cjs', '.jsx'].includes(ext)) {
    let syntaxNote = '';
    if (ext !== '.jsx' && await has('node')) {
      const r = await runCmd('node', ['--check', filePath], cwd);
      if (r.code !== 0) return BAD('node --check', r.out.slice(0, 4000));
      syntaxNote = 'Sintaxis OK. ';
    }
    const rc = findUp(dir, '.eslintrc.json') || findUp(dir, '.eslintrc.js')
      || findUp(dir, 'eslint.config.js') || findUp(dir, 'eslint.config.mjs');
    if (rc) {
      const proj = path.dirname(rc);
      const eslint = await resolveBin(proj, 'eslint');
      if (eslint) {
        const r = await runCmd(eslint.cmd, [...eslint.pre, filePath, '--format', 'compact'], proj, 60000);
        return r.code === 0 ? OK('eslint', `${syntaxNote}Sin problemas de lint.`) : BAD('eslint', r.out.slice(0, 6000));
      }
    }
    return OK(syntaxNote ? 'node --check' : 'none', syntaxNote || 'No hay chequeador de JS disponible.');
  }

  // ── Go ────────────────────────────────────────────────────────────────────
  if (ext === '.go') {
    if (await has('gofmt')) {
      const r = await runCmd('gofmt', ['-e', filePath], cwd);
      if (r.code !== 0) return BAD('gofmt', r.out.slice(0, 4000));
    }
    if (await has('go')) {
      const r = await runCmd('go', ['vet', './...'], dir, 60000);
      return r.code === 0 ? OK('go vet', 'Sin problemas.') : BAD('go vet', r.out.slice(0, 6000));
    }
    return OK('none', 'Go no está instalado.');
  }

  // ── Shell (bash) ────────────────────────────────────────────────────────────
  if (ext === '.sh' || ext === '.bash') {
    if (await has('shellcheck')) {
      const r = await runCmd('shellcheck', ['-f', 'gcc', filePath], cwd);
      return r.code === 0 ? OK('shellcheck', 'Sin problemas.') : BAD('shellcheck', r.out.slice(0, 6000));
    }
    if (await has('bash')) {
      const r = await runCmd('bash', ['-n', filePath], cwd);
      return r.code === 0 ? OK('bash -n', 'Sintaxis OK.') : BAD('bash -n', r.out.slice(0, 4000));
    }
    return OK('none', 'No hay chequeador de shell (bash/shellcheck).');
  }

  // ── PHP ─────────────────────────────────────────────────────────────────────
  if (ext === '.php') {
    if (await has('php')) {
      const r = await runCmd('php', ['-l', filePath], cwd);
      return r.code === 0 ? OK('php -l', 'Sin errores de sintaxis.') : BAD('php -l', r.out.slice(0, 6000));
    }
    return OK('none', 'PHP no está instalado (pkg install php).');
  }

  // ── Ruby ──────────────────────────────────────────────────────────────────
  if (ext === '.rb') {
    if (await has('ruby')) {
      const r = await runCmd('ruby', ['-c', filePath], cwd);
      return r.code === 0 ? OK('ruby -c', 'Sintaxis OK.') : BAD('ruby -c', r.out.slice(0, 6000));
    }
    return OK('none', 'Ruby no está instalado (pkg install ruby).');
  }

  // ── C ───────────────────────────────────────────────────────────────────────
  if (ext === '.c' || ext === '.h') {
    const cc = (await has('gcc')) ? 'gcc' : (await has('clang') ? 'clang' : (await has('cc') ? 'cc' : null));
    if (cc) {
      const r = await runCmd(cc, ['-fsyntax-only', filePath], cwd);
      return r.code === 0 ? OK(cc, 'Sintaxis OK.') : BAD(cc, r.out.slice(0, 6000));
    }
    return OK('none', 'No hay compilador de C (gcc/clang).');
  }

  // ── C++ ───────────────────────────────────────────────────────────────────
  if (['.cc', '.cpp', '.cxx', '.hpp', '.hh'].includes(ext)) {
    const cxx = (await has('g++')) ? 'g++' : (await has('clang++') ? 'clang++' : null);
    if (cxx) {
      const r = await runCmd(cxx, ['-fsyntax-only', filePath], cwd);
      return r.code === 0 ? OK(cxx, 'Sintaxis OK.') : BAD(cxx, r.out.slice(0, 6000));
    }
    return OK('none', 'No hay compilador de C++ (g++/clang++).');
  }

  // ── Rust ──────────────────────────────────────────────────────────────────
  if (ext === '.rs') {
    const cargoToml = findUp(dir, 'Cargo.toml');
    if (cargoToml && await has('cargo')) {
      const r = await runCmd('cargo', ['check', '--message-format', 'short'], path.dirname(cargoToml), 120000);
      return r.code === 0 ? OK('cargo check', 'Sin problemas.') : BAD('cargo check', r.out.slice(0, 6000));
    }
    return OK('none', 'Para chequear Rust hace falta cargo + Cargo.toml (proyecto cargo).');
  }

  return OK('none', `No hay un chequeador de diagnósticos para "${ext || 'este tipo de archivo'}".`);
}
