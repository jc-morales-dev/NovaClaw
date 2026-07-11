import assert from 'node:assert/strict';
import test from 'node:test';

const { callModelWithTools } = await import('../src/agent/modelClient.ts');

// Respuesta fetch simulada (con .ok/.status/.headers.get/.json/.text).
function fakeRes(status, body, headers = {}) {
  const norm = {};
  for (const k of Object.keys(headers)) norm[k.toLowerCase()] = headers[k];
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => norm[String(k).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const anthropicOk = { content: [{ type: 'text', text: 'listo' }] };
const openaiOk = { choices: [{ message: { content: 'listo' } }] };

// Stub de globalThis.fetch que graba cada llamada y responde según una cola.
function stubFetch(queue) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    let body = {};
    try { body = JSON.parse(init?.body ?? '{}'); } catch { /* noop */ }
    calls.push({ url, headers: init?.headers ?? {}, body });
    const next = queue.shift();
    if (!next) throw new Error('sin respuestas en la cola');
    return next;
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const baseInput = {
  apiKey: 'k',
  system: 'sos NovaClaw',
  messages: [{ role: 'user', text: 'hola' }],
};

// ── B2: reintenta un 429 (respetando Retry-After) y termina bien ────────────
test('reintenta en 429 y luego responde', async () => {
  const { calls, restore } = stubFetch([
    fakeRes(429, { error: 'rate' }, { 'retry-after': '0' }),
    fakeRes(200, openaiOk),
  ]);
  try {
    const reply = await callModelWithTools({ ...baseInput, providerId: 'nvidia', model: 'x/y' });
    assert.equal(reply.text, 'listo');
    assert.equal(calls.length, 2, 'debió reintentar una vez');
  } finally { restore(); }
});

// ── B2: NO reintenta un 401 (error definitivo) ──────────────────────────────
test('no reintenta en 401', async () => {
  const { calls, restore } = stubFetch([fakeRes(401, 'no autorizado')]);
  try {
    await assert.rejects(
      callModelWithTools({ ...baseInput, providerId: 'nvidia', model: 'x/y' }),
      /401/,
    );
    assert.equal(calls.length, 1, 'no debe reintentar un 401');
  } finally { restore(); }
});

// ── B1 + thinking: Opus 4.8 usa cache_control y adaptive thinking ───────────
test('anthropic Opus 4.8: cache_control + adaptive thinking', async () => {
  const { calls, restore } = stubFetch([fakeRes(200, anthropicOk)]);
  try {
    await callModelWithTools({ ...baseInput, providerId: 'anthropic', model: 'claude-opus-4-8' });
    const { body } = calls[0];
    // system como bloque con cache_control (cachea tools+system)
    assert.ok(Array.isArray(body.system), 'system debe ser array de bloques');
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
    // adaptive thinking (NO el viejo budget_tokens que da 400 en Opus 4.8)
    assert.deepEqual(body.thinking, { type: 'adaptive' });
    // el último mensaje lleva cache_control (prefijo del historial)
    const lastMsg = body.messages[body.messages.length - 1];
    const lastBlock = lastMsg.content[lastMsg.content.length - 1];
    assert.deepEqual(lastBlock.cache_control, { type: 'ephemeral' });
  } finally { restore(); }
});

// ── thinking: modelo previo (Haiku 4.5) mantiene budget_tokens + beta header ─
test('anthropic Haiku 4.5: budget_tokens + interleaved beta', async () => {
  const { calls, restore } = stubFetch([fakeRes(200, anthropicOk)]);
  try {
    await callModelWithTools({ ...baseInput, providerId: 'anthropic', model: 'claude-haiku-4-5' });
    const { body, headers } = calls[0];
    assert.equal(body.thinking.type, 'enabled');
    assert.ok(body.thinking.budget_tokens > 0);
    assert.equal(headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');
  } finally { restore(); }
});

// ── B1: llamada sin tools (título/resumen) NO cachea (evita escritura inútil) ─
test('noTools no aplica cache_control', async () => {
  const { calls, restore } = stubFetch([fakeRes(200, anthropicOk)]);
  try {
    await callModelWithTools({ ...baseInput, providerId: 'anthropic', model: 'claude-opus-4-8', noTools: true });
    const { body } = calls[0];
    assert.equal(typeof body.system, 'string', 'sin tools el system queda como string sin cache');
    assert.equal(body.thinking, undefined, 'sin tools no manda thinking');
  } finally { restore(); }
});
