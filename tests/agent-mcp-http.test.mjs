import assert from 'node:assert/strict';
import http from 'node:http';

const { McpManager } = await import('../src/agent/mcp.ts');

// ── Servidor MCP mock por HTTP (Streamable HTTP) ─────────────────────────────
// Exige Authorization: Bearer <token>. Responde JSON o SSE según Accept.
let seenAuth = '';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seenAuth = req.headers['authorization'] ?? '';
    if (seenAuth !== 'Bearer secreto-remoto') {
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }
    const msg = JSON.parse(body || '{}');
    const reply = (result) => {
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      // Responder como SSE para ejercitar el parser de event-stream.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Mcp-Session-Id', 'sess-1');
      res.end(`event: message\ndata: ${payload}\n\n`);
    };
    switch (msg.method) {
      case 'initialize':
        reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'remoto', version: '1' } });
        break;
      case 'notifications/initialized':
        res.statusCode = 202; res.end(''); break;
      case 'tools/list':
        reply({ tools: [{ name: 'suma', description: 'suma a+b', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }] });
        break;
      case 'tools/call':
        if (msg.params?.name === 'suma') {
          const { a = 0, b = 0 } = msg.params.arguments ?? {};
          reply({ content: [{ type: 'text', text: `resultado: ${a + b}` }] });
        } else {
          reply({ isError: true, content: [{ type: 'text', text: 'tool desconocida' }] });
        }
        break;
      default:
        reply({});
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/mcp`;

// ── Conectar por HTTP con token en el header (resuelto de ${SECRET:remoto}) ──
{
  const mgr = new McpManager();
  const { connected, failed } = await mgr.connectAll(
    { remoto: { url, headers: { Authorization: 'Bearer ${SECRET:remoto}' } } },
    async (id) => (id === 'remoto' ? 'secreto-remoto' : null),
  );
  assert.deepEqual(connected, ['remoto'], `debe conectar por HTTP (failed=${JSON.stringify(failed)})`);

  const tools = mgr.listTools();
  assert.equal(tools.length, 1, 'una tool remota descubierta');
  assert.equal(tools[0].name, 'mcp__remoto__suma');

  const out = await mgr.call('mcp__remoto__suma', { a: 2, b: 3 });
  assert.equal(out, 'resultado: 5', 'la tool remota ejecuta por HTTP (SSE) y devuelve el resultado');

  mgr.closeAll();
}

// ── Sin token → 401 con motivo claro ─────────────────────────────────────────
{
  const mgr = new McpManager();
  const { connected, failed } = await mgr.connectAll({ remoto: { url } });
  assert.deepEqual(connected, [], 'sin token no conecta');
  const f = failed.find((x) => x.name === 'remoto');
  assert.match(f.error, /401|autenticaci/i, 'el motivo indica falta de autenticación');
  mgr.closeAll();
}

server.close();
console.log('agent-mcp-http.test.mjs passed');
