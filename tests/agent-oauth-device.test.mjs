import assert from 'node:assert/strict';
import http from 'node:http';

const { startDeviceFlow, pollDeviceToken } = await import('../src/agent/oauthDevice.ts');

// ── Servidor OAuth mock (device flow, RFC 8628) ──────────────────────────────
// /device → da device_code+user_code. /token → 'authorization_pending' las
// primeras 2 veces, luego devuelve el access_token (simula al usuario autorizando).
let tokenPolls = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/device') {
      res.end(JSON.stringify({
        device_code: 'DEV-123',
        user_code: 'WXYZ-1234',
        verification_uri: 'https://example.com/activate',
        verification_uri_complete: 'https://example.com/activate?code=WXYZ-1234',
        interval: 1,
        expires_in: 300,
      }));
    } else if (req.url === '/token') {
      tokenPolls += 1;
      if (tokenPolls < 3) res.end(JSON.stringify({ error: 'authorization_pending' }));
      else res.end(JSON.stringify({ access_token: 'gho_resuelto_456', token_type: 'bearer' }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const spec = {
  deviceAuthUrl: `http://127.0.0.1:${port}/device`,
  tokenUrl: `http://127.0.0.1:${port}/token`,
  clientId: 'test-client',
  scope: 'repo',
};

// Paso 1: start.
const start = await startDeviceFlow(spec);
assert.equal(start.userCode, 'WXYZ-1234', 'devuelve el user_code para mostrar');
assert.equal(start.deviceCode, 'DEV-123');
assert.equal(start.verificationUri, 'https://example.com/activate');
assert.equal(start.interval, 1);

// Paso 2: polling — pending, pending, authorized.
const p1 = await pollDeviceToken(spec, start.deviceCode);
assert.equal(p1.status, 'pending', 'primer poll: pendiente');
const p2 = await pollDeviceToken(spec, start.deviceCode);
assert.equal(p2.status, 'pending', 'segundo poll: pendiente');
const p3 = await pollDeviceToken(spec, start.deviceCode);
assert.equal(p3.status, 'authorized', 'tercer poll: autorizado');
assert.equal(p3.token, 'gho_resuelto_456', 'devuelve el access_token');

// access_denied → denied.
tokenPolls = 100;
const denyServer = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'access_denied' }));
  });
});
await new Promise((resolve) => denyServer.listen(0, '127.0.0.1', resolve));
const denySpec = { ...spec, tokenUrl: `http://127.0.0.1:${denyServer.address().port}/token` };
const denied = await pollDeviceToken(denySpec, 'x');
assert.equal(denied.status, 'denied', 'access_denied → denied');

server.close();
denyServer.close();
console.log('agent-oauth-device.test.mjs passed');
