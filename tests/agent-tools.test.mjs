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

// ── file.read: números de línea estilo cat -n ─────────────────────────────────
{
  const file = await writeFixture('lineas.txt', 'alfa\nbeta\ngamma\n');
  const res = await executor({ tool: 'file.read', arguments: { path: file } }, ctx);
  assert.equal(res.status, 'success', res.output);
  assert.match(res.output, /1\talfa/);
  assert.match(res.output, /2\tbeta/);
  assert.match(res.output, /3\tgamma/);
}

// ── file.read: offset + limit (ventana) ───────────────────────────────────────
{
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
  const file = await writeFixture('grande.txt', lines);
  const res = await executor({ tool: 'file.read', arguments: { path: file, offset: 5, limit: 3 } }, ctx);
  assert.equal(res.status, 'success', res.output);
  assert.match(res.output, /5\tline 5/);
  assert.match(res.output, /7\tline 7/);
  assert.doesNotMatch(res.output, /\b4\tline 4/);
  assert.doesNotMatch(res.output, /8\tline 8/);
  assert.match(res.output, /more lines below/);
}

// ── image.view: rechaza tipos no-imagen ───────────────────────────────────────
{
  const file = await writeFixture('noimg.txt', 'no soy imagen');
  const res = await executor({ tool: 'image.view', arguments: { path: file } }, ctx);
  assert.equal(res.status, 'error');
  assert.match(res.output, /Unsupported image type/);
}

// ── image.view: PNG real → devuelve base64 para visión ────────────────────────
{
  // PNG 1x1 transparente mínimo, en base64.
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const imgPath = path.join(workspaceRoot, 'pixel.png');
  await fs.writeFile(imgPath, Buffer.from(pngB64, 'base64'));
  const res = await executor({ tool: 'image.view', arguments: { path: imgPath } }, ctx);
  assert.equal(res.status, 'success', res.output);
  assert.ok(res.image, 'debe adjuntar la imagen');
  assert.equal(res.image.mediaType, 'image/png');
  assert.equal(res.image.data, pngB64);
}

// ── file.edit_multi: varias ediciones atómicas exitosas ──────────────────────
{
  const file = await writeFixture('multi-ok.txt', 'uno\ndos\ntres\n');
  const res = await executor(
    {
      tool: 'file.edit_multi',
      arguments: {
        path: file,
        edits: [
          { old_string: 'uno', new_string: '1' },
          { old_string: 'tres', new_string: '3' },
        ],
      },
    },
    ctx,
  );
  assert.equal(res.status, 'success', res.output);
  const content = await fs.readFile(file, 'utf8');
  assert.equal(content, '1\ndos\n3\n');
}

// ── file.edit_multi: si una edición falla, NO escribe nada (atómico) ──────────
{
  const original = 'alfa\nbeta\n';
  const file = await writeFixture('multi-atomic.txt', original);
  const res = await executor(
    {
      tool: 'file.edit_multi',
      arguments: {
        path: file,
        edits: [
          { old_string: 'alfa', new_string: 'A' }, // matchea
          { old_string: 'no-existe', new_string: 'X' }, // NO matchea → aborta todo
        ],
      },
    },
    ctx,
  );
  assert.equal(res.status, 'error');
  assert.match(res.output, /atómico/);
  const content = await fs.readFile(file, 'utf8');
  assert.equal(content, original, 'el archivo no debe cambiar si alguna edición falla');
}

await fs.rm(workspaceRoot, { recursive: true, force: true });
console.log('agent-tools.test.mjs passed');
