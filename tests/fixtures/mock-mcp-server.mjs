// Servidor MCP mínimo por stdio, para tests. Implementa initialize, tools/list
// y tools/call (tools "echo" y "token") con JSON-RPC delimitado por saltos de línea.
// MOCK_FAIL=1 → escribe a stderr y sale antes de handshake (prueba de captura de stderr).
if (process.env.MOCK_FAIL) {
  process.stderr.write('MOCK_FAIL: falta el TOKEN de prueba\n');
  process.exit(1);
}
let buffer = '';
process.stdin.on('data', (d) => {
  buffer += d.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1' } } });
      break;
    case 'notifications/initialized':
      break; // notificación: sin respuesta
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            { name: 'echo', description: 'Devuelve el texto recibido', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
            { name: 'token', description: 'Devuelve el MOCK_TOKEN del entorno', inputSchema: { type: 'object', properties: {} } },
          ],
        },
      });
      break;
    case 'tools/call':
      if (msg.params?.name === 'echo') {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo: ${msg.params?.arguments?.text ?? ''}` }] } });
      } else if (msg.params?.name === 'token') {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `token: ${process.env.MOCK_TOKEN ?? '(none)'}` }] } });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'tool desconocida' } });
      }
      break;
    default:
      if (typeof msg.id === 'number') send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'método no soportado' } });
  }
}
