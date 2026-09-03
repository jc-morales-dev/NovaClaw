/**
 * Tests adversariales del streaming: lo que pasa cuando la red del teléfono
 * (no un servidor de laboratorio) entrega el SSE. Cada caso acá es un fallo
 * observado en clientes SSE reales, no una hipótesis:
 *   - el chunk TCP corta un evento por la mitad
 *   - un emoji queda partido entre dos chunks (UTF-8 multibyte)
 *   - el stream muere sin cerrar el mensaje (túnel que se cae)
 *   - el modelo emite JSON de tool_use truncado
 *   - llegan pings y líneas vacías entre eventos
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { callModelWithTools } = await import('../src/agent/modelClient.ts');

/** Respuesta SSE cuyo cuerpo se entrega en trozos EXACTAMENTE como se pidan,
 *  para poder cortar en el peor lugar posible. */
function rawStream(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c);
      controller.close();
    },
  });
  return { ok: true, status: 200, body, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
}

function stubFetch(queue) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    let body = {};
    try { body = JSON.parse(init?.body ?? '{}'); } catch { /* noop */ }
    calls.push({ url, body });
    const next = queue.shift();
    if (!next) throw new Error('sin respuestas en la cola');
    return next;
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const base = { apiKey: 'k', system: 's', messages: [{ role: 'user', text: 'hola' }], providerId: 'anthropic', model: 'claude-opus-4-8' };

// ── 1. El chunk TCP corta un evento por la mitad ─────────────────────────────
test('SSE partido en cualquier byte: no pierde ni duplica texto', async () => {
  const full = [
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hola mundo' } }),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
  ].join('');

  // Cortes en posiciones perversas: dentro del JSON, justo antes del \n, etc.
  for (const size of [1, 3, 7, 17, 64, 999]) {
    const chunks = [];
    for (let i = 0; i < full.length; i += size) chunks.push(full.slice(i, i + size));
    const { restore } = stubFetch([rawStream(chunks)]);
    try {
      const deltas = [];
      const reply = await callModelWithTools({ ...base, onTextDelta: (d) => deltas.push(d) });
      assert.equal(reply.text, 'hola mundo', `texto intacto con chunks de ${size} bytes`);
      assert.equal(deltas.join(''), 'hola mundo', `deltas intactos con chunks de ${size} bytes`);
    } finally { restore(); }
  }
});

// ── 2. Emoji partido entre dos chunks (UTF-8 multibyte) ──────────────────────
test('emoji cortado a la mitad entre chunks no se corrompe', async () => {
  const payload = sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    + sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '¡listo 🚀 ñandú!' } })
    + sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });

  const bytes = new TextEncoder().encode(payload);
  // Cortar a mitad del emoji: buscamos el primer byte 0xF0 (inicio de 4-byte UTF-8).
  const cut = bytes.indexOf(0xf0) + 2;
  const { restore } = stubFetch([rawStream([bytes.slice(0, cut), bytes.slice(cut)])]);
  try {
    const reply = await callModelWithTools({ ...base, onTextDelta: () => {} });
    assert.equal(reply.text, '¡listo 🚀 ñandú!', 'el emoji y los acentos sobreviven al corte');
  } finally { restore(); }
});

// ── 3. El stream muere sin cerrar el mensaje ─────────────────────────────────
test('stream cortado a la mitad: devuelve lo que alcanzó, no una burbuja vacía', async () => {
  const { restore } = stubFetch([rawStream([
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'iba por la mitad' } }),
    // …y acá se cae el túnel: sin content_block_stop ni message_delta.
  ])]);
  try {
    const reply = await callModelWithTools({ ...base, onTextDelta: () => {} });
    assert.equal(reply.text, 'iba por la mitad', 'conserva el texto parcial');
  } finally { restore(); }
});

test('stream que no entrega NADA: avisa en vez de dejar la burbuja vacía', async () => {
  const { restore } = stubFetch([rawStream([''])]);
  try {
    const reply = await callModelWithTools({ ...base, onTextDelta: () => {} });
    assert.ok(reply.text && reply.text.length > 0, 'debe explicar que no llegó respuesta');
    assert.match(reply.text, /vac|corta|respuesta/i);
  } finally { restore(); }
});

// ── 4. JSON de tool_use truncado ─────────────────────────────────────────────
test('input_json_delta truncado: no rompe el turno, deja args vacíos', async () => {
  const { restore } = stubFetch([rawStream([
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'terminal_run' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"l' } }),
    sse({ type: 'content_block_stop', index: 0 }),
    sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
  ])]);
  try {
    const reply = await callModelWithTools({ ...base, onTextDelta: () => {} });
    assert.equal(reply.toolCalls?.[0]?.name, 'terminal_run');
    assert.deepEqual(reply.toolCalls?.[0]?.args, {}, 'JSON roto → args vacíos, sin excepción');
  } finally { restore(); }
});

// ── 5. Ruido del protocolo: pings, líneas vacías, CRLF, event: ───────────────
test('pings, CRLF y líneas event: no ensucian el texto', async () => {
  const { restore } = stubFetch([rawStream([
    ': ping\n\n',
    'event: content_block_start\r\n' + `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\r\n\r\n`,
    '\n',
    ': keep-alive\n\n',
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'limpio' } }),
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
  ])]);
  try {
    const reply = await callModelWithTools({ ...base, onTextDelta: () => {} });
    assert.equal(reply.text, 'limpio');
  } finally { restore(); }
});

// ── 6. Delta para un índice que nunca abrió su bloque ────────────────────────
test('content_block_delta huérfano no tumba el stream', async () => {
  const { restore } = stubFetch([rawStream([
    sse({ type: 'content_block_delta', index: 7, delta: { type: 'text_delta', text: 'fantasma' } }),
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'real' } }),
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
  ])]);
  try {
    const reply = await callModelWithTools({ ...base, onTextDelta: () => {} });
    assert.equal(reply.text, 'real', 'ignora el huérfano y conserva lo válido');
  } finally { restore(); }
});

// ── 7. Un sink de deltas que explota no debe frenar la respuesta ─────────────
test('si la UI tira excepción en onTextDelta, el stream sigue', async () => {
  const { restore } = stubFetch([rawStream([
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'b' } }),
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
  ])]);
  try {
    const reply = await callModelWithTools({ ...base, onTextDelta: () => { throw new Error('UI rota'); } });
    assert.equal(reply.text, 'ab', 'la respuesta llega igual');
  } finally { restore(); }
});

// ── 8. Varios bloques de texto se concatenan en orden ────────────────────────
test('múltiples bloques de texto mantienen el orden', async () => {
  const { restore } = stubFetch([rawStream([
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'uno ' } }),
    sse({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } }),
    sse({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'pienso' } }),
    sse({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }),
    sse({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'dos' } }),
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
  ])]);
  try {
    const reply = await callModelWithTools({ ...base, onTextDelta: () => {} });
    assert.equal(reply.text, 'uno dos', 'el thinking no se mezcla con el texto visible');
    assert.equal(reply.rawContent?.length, 3, 'los tres bloques viajan en rawContent para el replay');
  } finally { restore(); }
});
