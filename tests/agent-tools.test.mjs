import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { createLocalToolExecutor } = await import('../src/agent/tools.ts');

const executor = createLocalToolExecutor();
const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novaclaw-tools-'));
const ctx = { cwd: workspaceRoot, workspaceRoot };

async function writeFixture(rel, content) {
  const full = path.join(workspaceRoot, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
  return full;
}

// ── file.edit: reemplazo único ────────────────────────────────────────────────
{
  const file = await writeFixture('edit-unico.txt', 'hola mundo\nsegunda linea\n');
  const res = await executor(
    { tool: 'file.edit', arguments: { path: file, old_string: 'hola mundo', new_string: 'hola NovaClaw' } },
    ctx,
  );
  assert.equal(res.status, 'success', res.output);
  const content = await fs.readFile(file, 'utf8');
  assert.equal(content, 'hola NovaClaw\nsegunda linea\n');
}

// ── file.edit: old_string inexistente → error claro ───────────────────────────
{
  const file = await writeFixture('edit-noexiste.txt', 'contenido\n');
  const res = await executor(
    { tool: 'file.edit', arguments: { path: file, old_string: 'no-esta', new_string: 'x' } },
    ctx,
  );
  assert.equal(res.status, 'error');
  assert.match(res.output, /NOT found/);
}

// ── file.edit: múltiples ocurrencias sin replace_all → error con conteo ───────
{
  const file = await writeFixture('edit-multi.txt', 'mundo uno\nmundo dos\n');
  const res = await executor(
    { tool: 'file.edit', arguments: { path: file, old_string: 'mundo', new_string: 'planeta' } },
    ctx,
  );
  assert.equal(res.status, 'error');
  assert.match(res.output, /2 times/);
}

// ── file.edit: replace_all reemplaza todas ─────────────────────────────────────
{
  const file = await writeFixture('edit-all.txt', 'mundo uno\nmundo dos\n');
  const res = await executor(
    { tool: 'file.edit', arguments: { path: file, old_string: 'mundo', new_string: 'planeta', replace_all: true } },
    ctx,
  );
  assert.equal(res.status, 'success', res.output);
  const content = await fs.readFile(file, 'utf8');
  assert.equal(content, 'planeta uno\nplaneta dos\n');
}

// ── file.edit: archivo inexistente → sugiere file_write ──────────────────────
{
  const res = await executor(
    { tool: 'file.edit', arguments: { path: path.join(workspaceRoot, 'nope.txt'), old_string: 'a', new_string: 'b' } },
    ctx,
  );
  assert.equal(res.status, 'error');
  assert.match(res.output, /file_write/);
}

// ── file.grep: encuentra con ruta:línea y excluye node_modules ────────────────
{
  await writeFixture('src/calculo.js', 'function suma(a, b) {\n  return a + b;\n}\n');
  await writeFixture('node_modules/paquete/index.js', 'function suma() { /* no debe aparecer */ }\n');
  const res = await executor(
    { tool: 'file.grep', arguments: { pattern: 'function\\s+suma', path: workspaceRoot } },
    ctx,
  );
  assert.equal(res.status, 'success', res.output);
  assert.match(res.output, /calculo\.js:1/);
  assert.doesNotMatch(res.output, /node_modules/);
}

// ── file.grep: sin coincidencias → mensaje claro ──────────────────────────────
{
  const res = await executor(
    { tool: 'file.grep', arguments: { pattern: 'texto_que_no_existe_9999', path: workspaceRoot } },
    ctx,
  );
  assert.equal(res.status, 'success');
  assert.match(res.output, /No matches/);
}

// ── file.grep: regex inválida → error, no crash ───────────────────────────────
{
  const res = await executor(
    { tool: 'file.grep', arguments: { pattern: '([abierto', path: workspaceRoot } },
    ctx,
  );
  assert.equal(res.status, 'error');
  assert.match(res.output, /Invalid regular expression/);
}

// ── web.fetch: rechaza URLs no-http ───────────────────────────────────────────
{
  const res = await executor(
    { tool: 'web.fetch', arguments: { url: 'file:///etc/passwd' } },
    ctx,
  );
  assert.equal(res.status, 'error');
  assert.match(res.output, /http\(s\)/);
}

await fs.rm(workspaceRoot, { recursive: true, force: true });
console.log('agent-tools.test.mjs passed');
