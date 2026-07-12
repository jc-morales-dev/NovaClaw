import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { runDiagnostics } = await import('../src/agent/diagnostics.ts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-diag-'));

// ── JSON válido / inválido ────────────────────────────────────────────────────
{
  const good = path.join(dir, 'ok.json');
  fs.writeFileSync(good, '{"a": 1, "b": [2,3]}', 'utf8');
  const r = await runDiagnostics(good, dir);
  assert.equal(r.tool, 'json');
  assert.equal(r.ok, true, 'JSON válido debe pasar');

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{"a": 1,, }', 'utf8');
  const r2 = await runDiagnostics(bad, dir);
  assert.equal(r2.ok, false, 'JSON inválido debe fallar');
  assert.match(r2.output, /inválido/i);
}

// ── JS: node --check detecta error de sintaxis ────────────────────────────────
{
  const bad = path.join(dir, 'bad.js');
  fs.writeFileSync(bad, 'const x = ;\n', 'utf8');
  const r = await runDiagnostics(bad, dir);
  // node siempre está en el entorno de tests → debe detectar el error de sintaxis.
  assert.equal(r.ok, false, 'JS con error de sintaxis debe fallar');
  assert.equal(r.tool, 'node --check');

  const good = path.join(dir, 'ok.js');
  fs.writeFileSync(good, 'const x = 1;\nconsole.log(x);\n', 'utf8');
  const r2 = await runDiagnostics(good, dir);
  assert.equal(r2.ok, true, 'JS válido debe pasar');
}

// ── Extensión sin chequeador: no rompe, devuelve ok con nota ──────────────────
{
  const txt = path.join(dir, 'notas.txt');
  fs.writeFileSync(txt, 'hola', 'utf8');
  const r = await runDiagnostics(txt, dir);
  assert.equal(r.ok, true);
  assert.equal(r.tool, 'none');
}

// ── Archivo inexistente ───────────────────────────────────────────────────────
{
  const r = await runDiagnostics(path.join(dir, 'no-existe.py'), dir);
  assert.equal(r.ok, false);
  assert.match(r.output, /no encontrado/i);
}

// ── Lenguajes extra: despacho sin crash y forma correcta del resultado ────────
// (bash/php/ruby/etc pueden no estar instalados → toleramos ok=true/tool=none;
//  si el chequeador existe, un archivo con error de sintaxis debe fallar.)
for (const [name, content] of [
  ['roto.sh', 'if [ 1 -eq 1 ; then echo hi\n'],   // falta ]
  ['roto.php', '<?php echo "x" \n'],               // falta ;
  ['roto.rb', 'def foo\n  puts "x"\n'],            // falta end
]) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, content, 'utf8');
  const r = await runDiagnostics(f, dir);
  assert.equal(typeof r.ok, 'boolean', `${name}: ok debe ser boolean`);
  assert.equal(typeof r.tool, 'string', `${name}: tool debe ser string`);
  // Si hay chequeador real (tool != none) debe marcar el error; si no, degrada a none.
  assert.ok(r.tool === 'none' || r.ok === false, `${name}: con chequeador real debe fallar`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('agent-diagnostics.test.mjs passed');
