import assert from 'node:assert/strict';
import { test } from 'node:test';

const { encodeMessage, LspMessageBuffer } = await import('../src/agent/lspClient.ts');
const { createLocalToolExecutor } = await import('../src/agent/tools.ts');
const { TOOL_SCHEMAS, TOOL_NAME_TO_DOT } = await import('../src/agent/toolSchemas.ts');
const { READ_ONLY_TOOLS } = await import('../src/agent/nativeAgentSupport.ts');

test('encodeMessage usa Content-Length en BYTES (no chars)', () => {
  const enc = encodeMessage({ a: 'ñ' }); // "ñ" son 2 bytes
  const m = enc.match(/^Content-Length: (\d+)\r\n\r\n([\s\S]*)$/);
  assert.ok(m, 'formato de cabecera correcto');
  assert.equal(Number(m[1]), Buffer.byteLength(m[2], 'utf8'));
});

test('LspMessageBuffer parsea un mensaje completo', () => {
  const buf = new LspMessageBuffer();
  const msg = { jsonrpc: '2.0', id: 1, result: { ok: true } };
  assert.deepEqual(buf.append(encodeMessage(msg)), [msg]);
});

test('LspMessageBuffer re-arma un mensaje partido en chunks', () => {
  const buf = new LspMessageBuffer();
  const e = encodeMessage({ jsonrpc: '2.0', id: 2, method: 'm' });
  const mid = Math.floor(e.length / 2);
  assert.deepEqual(buf.append(e.slice(0, mid)), []); // incompleto → nada aún
  assert.deepEqual(buf.append(e.slice(mid)), [{ jsonrpc: '2.0', id: 2, method: 'm' }]);
});

test('LspMessageBuffer extrae VARIOS mensajes de un solo chunk', () => {
  const buf = new LspMessageBuffer();
  const two = encodeMessage({ id: 1, method: 'a' }) + encodeMessage({ id: 2, method: 'b' });
  const got = buf.append(two);
  assert.equal(got.length, 2);
  assert.equal(got[0].method, 'a');
  assert.equal(got[1].method, 'b');
});

test('LspMessageBuffer es robusto con UTF-8 partido entre chunks', () => {
  const buf = new LspMessageBuffer();
  const bytes = Buffer.from(encodeMessage({ id: 1, text: 'ñoño 日本語' }), 'utf8');
  assert.deepEqual(buf.append(bytes.subarray(0, 18)), []); // corta a mitad de cabecera/char
  const rest = buf.append(bytes.subarray(18));
  assert.equal(rest.length, 1);
  assert.equal(rest[0].text, 'ñoño 日本語');
});

// ── Guards del tool code.intel (no spawnean el server) ────────────────────────
const executor = createLocalToolExecutor();
const ctx = { cwd: process.cwd(), workspaceRoot: process.cwd() };

test('code.intel con action inválida → error claro', async () => {
  const r = await executor({ tool: 'code.intel', arguments: { action: 'bogus' } }, ctx);
  assert.equal(r.status, 'error');
  assert.match(r.output, /action must be/);
});

test('code.intel symbols sin path → error', async () => {
  const r = await executor({ tool: 'code.intel', arguments: { action: 'symbols' } }, ctx);
  assert.equal(r.status, 'error');
  assert.match(r.output, /file path/i);
});

test('code.intel find sin query → error', async () => {
  const r = await executor({ tool: 'code.intel', arguments: { action: 'find' } }, ctx);
  assert.equal(r.status, 'error');
  assert.match(r.output, /query/i);
});

test('code_intel registrado: schema + mapeo, y FUERA del fast-path', () => {
  const schema = TOOL_SCHEMAS.find((t) => t.name === 'code_intel');
  assert.ok(schema, 'falta el schema code_intel');
  assert.deepEqual(schema.parameters.required, ['action']);
  assert.equal(TOOL_NAME_TO_DOT.code_intel, 'code.intel');
  // Ya no es read-only: arranca el language server de node_modules del proyecto,
  // o sea que ejecuta código del workspace. El fast-path no consulta la política
  // de aprobación, así que estar ahí equivalía a saltársela.
  assert.equal(READ_ONLY_TOOLS.has('code_intel'), false);
});

console.log('agent-lsp.test.mjs passed');
