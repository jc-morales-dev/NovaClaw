/**
 * Motor de diagnósticos: le da "ojos" al agente. Tras editar un archivo, corre el
 * type-checker/linter real del lenguaje (tsc, ruff, eslint, node --check, go vet…)
 * y devuelve los errores del compilador — así el agente ve sus errores de verdad
 * en vez de adivinar. Es la pieza que acerca el agente al nivel de OpenCode (LSP).
 *
 * Nunca auto-instala herramientas (no usa `npx <pkg>` que descargaría): si el
 * chequeador no está, lo dice y sugiere cómo instalarlo.
 */
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execCallback);

function shell(): string | undefined {
  return process.env.SHELL || undefined;
}

async function has(bin: string): Promise<boolean> {
  // command -v en POSIX (teléfono), where en Windows (dev).
  const probe = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
  try {
    await exec(probe, { shell: shell(), timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function runCmd(cmd: string, cwd: string, timeoutMs = 30000): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec(cmd, { cwd, shell: shell(), timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
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

/** Resuelve un binario de node_modules/.bin del proyecto, o global, o null (sin auto-instalar). */
async function resolveBin(projectDir: string, bin: string): Promise<string | null> {
  const local = path.join(projectDir, 'node_modules', '.bin', bin);
  if (fs.existsSync(local)) return `"${local}"`;
  if (await has(bin)) return bin;
  return null;
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
      const r = await runCmd(`ruff check "${filePath}"`, cwd);
      return r.code === 0 ? OK('ruff', 'Sin problemas.') : BAD('ruff', r.out.slice(0, 6000));
    }
    if (await has('pyflakes')) {
      const r = await runCmd(`pyflakes "${filePath}"`, cwd);
      return r.code === 0 ? OK('pyflakes', 'Sin problemas.') : BAD('pyflakes', r.out.slice(0, 6000));
    }
    const py = (await has('python')) ? 'python' : (await has('python3') ? 'python3' : null);
    if (py) {
      const r = await runCmd(`${py} -m py_compile "${filePath}"`, cwd);
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
    const r = await runCmd(`${tsc} --noEmit --pretty false -p "${tsconfig}"`, proj, 120000);
    if (r.code === 0) return OK('tsc', 'Sin errores de tipos.');
    // Enfocar a los errores del archivo editado para no abrumar el contexto.
    const focused = r.out.split('\n').filter((l) => l.includes(base)).join('\n');
    return BAD('tsc', (focused || r.out).slice(0, 6000));
  }

  // ── JavaScript ──────────────────────────────────────────────────────────────
  if (['.js', '.mjs', '.cjs', '.jsx'].includes(ext)) {
    let syntaxNote = '';
    if (ext !== '.jsx' && await has('node')) {
      const r = await runCmd(`node --check "${filePath}"`, cwd);
      if (r.code !== 0) return BAD('node --check', r.out.slice(0, 4000));
      syntaxNote = 'Sintaxis OK. ';
    }
    const rc = findUp(dir, '.eslintrc.json') || findUp(dir, '.eslintrc.js')
      || findUp(dir, 'eslint.config.js') || findUp(dir, 'eslint.config.mjs');
    if (rc) {
      const proj = path.dirname(rc);
      const eslint = await resolveBin(proj, 'eslint');
      if (eslint) {
        const r = await runCmd(`${eslint} "${filePath}" --format compact`, proj, 60000);
        return r.code === 0 ? OK('eslint', `${syntaxNote}Sin problemas de lint.`) : BAD('eslint', r.out.slice(0, 6000));
      }
    }
    return OK(syntaxNote ? 'node --check' : 'none', syntaxNote || 'No hay chequeador de JS disponible.');
  }

  // ── Go ────────────────────────────────────────────────────────────────────
  if (ext === '.go') {
    if (await has('gofmt')) {
      const r = await runCmd(`gofmt -e "${filePath}"`, cwd);
      if (r.code !== 0) return BAD('gofmt', r.out.slice(0, 4000));
    }
    if (await has('go')) {
      const r = await runCmd('go vet ./...', dir, 60000);
      return r.code === 0 ? OK('go vet', 'Sin problemas.') : BAD('go vet', r.out.slice(0, 6000));
    }
    return OK('none', 'Go no está instalado.');
  }

  return OK('none', `No hay un chequeador de diagnósticos para "${ext || 'este tipo de archivo'}".`);
}
