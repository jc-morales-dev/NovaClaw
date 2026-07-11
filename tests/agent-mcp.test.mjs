import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { McpManager } = await import('../src/agent/mcp.ts');
const { MCP_CATALOG, findCatalogEntry, catalogForClient } = await import('../src/agent/mcpCatalog.ts');

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
  assert.equal(tools.length, 2, 'dos tools descubiertas (echo + token)');
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

// ── Catálogo curado ──────────────────────────────────────────────────────────
{
  assert.ok(MCP_CATALOG.length >= 5, 'el catálogo tiene entradas');
  assert.equal(findCatalogEntry('github')?.id, 'github', 'match por id');
  assert.equal(findCatalogEntry('GitHub')?.id, 'github', 'match por label');
  assert.equal(findCatalogEntry('gh')?.id, 'github', 'match por alias');
  assert.equal(findCatalogEntry('instalá el MCP de github')?.id, 'github', 'match dentro de frase');
  assert.equal(findCatalogEntry('nada-de-esto'), undefined, 'sin match devuelve undefined');

  // La vista para el cliente NO expone secretos, solo metadatos.
  const view = catalogForClient();
  const gh = view.find((e) => e.id === 'github');
  assert.equal(gh.needsSecret, true, 'github pide token');
  assert.equal(gh.secretLabel, 'Token de GitHub');
  assert.ok(!('secret' in gh), 'la vista del cliente no lleva el objeto secret');
  const fsEntry = view.find((e) => e.id === 'filesystem');
  assert.equal(fsEntry.needsSecret, false, 'filesystem no pide token');
}

// ── Resolución de secretos: ${SECRET:<id>} → valor real (nunca en el config) ──
{
  const mgr = new McpManager();
  const { connected } = await mgr.connectAll(
    { sec: { command: process.execPath, args: [mockServer], env: { MOCK_TOKEN: '${SECRET:sec}' } } },
    async (id) => (id === 'sec' ? 'sk-resuelto-123' : null),
  );
  assert.deepEqual(connected, ['sec'], 'conecta resolviendo el secreto');
  const out = await mgr.call('mcp__sec__token', {});
  assert.equal(out, 'token: sk-resuelto-123', 'el placeholder se resolvió al valor real en el env del proceso');
  mgr.closeAll();
}

// ── Captura de stderr en el fallo (para que el agente sepa qué falta) ─────────
{
  const mgr = new McpManager();
  const { failed } = await mgr.connectAll({
    falla: { command: process.execPath, args: [mockServer], env: { MOCK_FAIL: '1' } },
  });
  const f = failed.find((x) => x.name === 'falla');
  assert.ok(f, 'el servidor que falla figura en failed');
  assert.match(f.error, /MOCK_FAIL|TOKEN/, 'el motivo incluye el stderr del servidor');
  mgr.closeAll();
}

console.log('agent-mcp.test.mjs passed');
