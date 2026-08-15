// Los chequeadores que viven en node_modules/.bin del proyecto tienen que
// seguir ejecutándose después de quitar el shell.
//
// En POSIX (el teléfono) el shim de npm es un script con shebang y execFile lo
// ejecuta. En Windows NO: `node_modules/.bin/tsc` es un script sh sin extensión
// y execFile falla con ENOENT — hay .cmd/.ps1 al lado, pero lanzarlos exigiría
// volver al shell, que es justo lo que quitamos. La salida es lanzar el .js real
// con el propio Node (process.execPath).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { runDiagnostics } = await import('../src/agent/diagnostics.ts');

// Este repo tiene tsconfig.json y typescript en node_modules: sirve de proyecto
// real. El archivo va en tmp/ (ignorado por git) para que findUp llegue acá.
const repoRoot = path.resolve('.');
const repoTmp = path.join(repoRoot, 'tmp');
await fs.mkdir(repoTmp, { recursive: true });
const tmpDir = await fs.mkdtemp(path.join(repoTmp, 'diag-entrypoint-'));

const archivo = path.join(tmpDir, 'diag-entrypoint.ts');
await fs.writeFile(archivo, 'export const saludo: string = "hola";\n', 'utf8');

try {
  const r = await runDiagnostics(archivo, tmpDir);

  // Lo que importa es que el binario CORRIÓ. Si el entrypoint está roto, runCmd
  // devuelve el ENOENT como si fuera un error de tipos y el tool queda en 'none'.
  assert.equal(r.tool, 'tsc', `tsc debe ejecutarse de verdad (tool=${r.tool}, out=${r.output.slice(0, 200)})`);
  assert.equal(r.ok, true, `el entrypoint debe completar el typecheck (out=${r.output.slice(0, 200)})`);
  assert.doesNotMatch(r.output, /ENOENT|spawn|no such file/i, 'no debe fallar al lanzar el binario');
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

if (process.platform === 'win32') {
  // También cubre un CLI npm GLOBAL: `where tsc` devuelve tsc.cmd, que execFile
  // no puede ejecutar directamente. Se extrae su entrypoint JS y se lanza con
  // process.execPath, igual que el shim local.
  const globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novaclaw-global-cli-'));
  const fakeBin = path.join(globalRoot, 'bin');
  const fakeEntry = path.join(fakeBin, 'node_modules', 'fake-tsc', 'bin', 'tsc.js');
  const project = path.join(globalRoot, 'project');
  await fs.mkdir(path.dirname(fakeEntry), { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(fakeEntry, 'process.exit(0);\n', 'utf8');
  await fs.writeFile(
    path.join(fakeBin, 'tsc.cmd'),
    '@echo off\r\n"%_prog%" "%dp0%\\node_modules\\fake-tsc\\bin\\tsc.js" %*\r\n',
    'utf8',
  );
  await fs.writeFile(path.join(project, 'tsconfig.json'), '{"compilerOptions":{}}\n', 'utf8');
  const globalSource = path.join(project, 'global.ts');
  await fs.writeFile(globalSource, 'export const x = 1;\n', 'utf8');
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = fakeBin;
    const globalResult = await runDiagnostics(globalSource, project);
    assert.equal(globalResult.tool, 'tsc');
    assert.equal(globalResult.ok, true, globalResult.output);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await fs.rm(globalRoot, { recursive: true, force: true });
  }
}

console.log('agent-exec-entrypoints.test.mjs passed');
