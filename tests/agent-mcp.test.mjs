import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { McpManager } = await import('../src/agent/mcp.ts');

const here = path.dirname(fileURLToPath(import.meta.url));
const mockServer = path.join(here, 'fixtures', 'mock-mcp-server.mjs');

// ── isMcpTool ─────────────────────────────────────────────────────────────────
assert.equal(McpManager.isMcpTool('mcp__x__y'), true);
assert.equal(McpManager.isMcpTool('file_read'), false);

// ── Conectar al servidor mock, listar y llamar una tool ──────────────────────
{
  const mgr = new McpManager();
  const { connected, failed } = await mgr.connectAll({
    mock: { command: process.execPath, args: [mockServer] },
  });
  assert.deepEqual(connected, ['mock'], `debe conectar (failed=${JSON.stringify(failed)})`);

  const tools = mgr.listTools();
  assert.equal(tools.length, 1, 'una tool descubierta');
  assert.equal(tools[0].name, 'mcp__mock__echo', 'nombre namespaced mcp__servidor__tool');
  assert.equal(tools[0].server, 'mock');
  assert.equal(tools[0].originalName, 'echo');

  const out = await mgr.call('mcp__mock__echo', { text: 'hola' });
  assert.equal(out, 'echo: hola', 'la tool ejecuta y devuelve el resultado');

  const unknown = await mgr.call('mcp__mock__nope', {});
  assert.match(unknown, /desconocida|error/i, 'tool inexistente devuelve error legible');

  mgr.closeAll();
}

// ── Un servidor que no arranca no rompe al resto ─────────────────────────────
{
  const mgr = new McpManager();
  const { connected, failed } = await mgr.connectAll({
    roto: { command: 'comando-que-no-existe-12345', args: [] },
    ok: { command: process.execPath, args: [mockServer] },
  });
  assert.ok(failed.some((f) => f.name === 'roto'), 'el servidor roto figura en failed');
  assert.deepEqual(connected, ['ok'], 'el bueno igual conecta');
  mgr.closeAll();
}

console.log('agent-mcp.test.mjs passed');
