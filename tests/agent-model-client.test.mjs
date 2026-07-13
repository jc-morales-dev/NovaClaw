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

// Respuesta SSE simulada (body = ReadableStream de chunks 'data: ...\n\n').
function sseRes(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return {
    ok: true, status: 200, body,
    headers: { get: () => null },
    json: async () => ({}), text: async () => '',
  };
}
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

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

// ── B10: camino OpenAI streamea — onTextDelta recibe fragmentos, arma texto+tools ─
test('OpenAI streaming: onTextDelta + acumula texto y tool_calls', async () => {
  const chunks = [
    sse({ choices: [{ delta: { content: 'Hola' } }] }),
    sse({ choices: [{ delta: { content: ' mundo' } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'terminal_run', arguments: '{"comm' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] }),
    'data: [DONE]\n\n',
  ];
  const { calls, restore } = stubFetch([sseRes(chunks)]);
  try {
    const deltas = [];
    const reply = await callModelWithTools({ ...baseInput, providerId: 'nvidia', model: 'x/y', onTextDelta: (d) => deltas.push(d) });
    assert.deepEqual(deltas, ['Hola', ' mundo'], 'debe emitir cada fragmento en vivo');
    assert.equal(reply.text, 'Hola mundo');
    assert.equal(reply.toolCalls?.[0]?.name, 'terminal_run');
    assert.deepEqual(reply.toolCalls?.[0]?.args, { command: 'ls' }, 'arma los args tool_call desde deltas');
    assert.equal(calls[0].body.stream, true, 'el request debe pedir stream:true');
  } finally { restore(); }
});

// ── B10: Anthropic NO streamea (protege el replay de thinking) ────────────────
test('Anthropic ignora onTextDelta (no streamea)', async () => {
  const { calls, restore } = stubFetch([fakeRes(200, anthropicOk)]);
  try {
    const deltas = [];
    const reply = await callModelWithTools({ ...baseInput, providerId: 'anthropic', model: 'claude-opus-4-8', onTextDelta: (d) => deltas.push(d) });
    assert.equal(deltas.length, 0, 'Anthropic no debe emitir deltas');
    assert.equal(reply.text, 'listo');
    assert.equal(calls[0].body.stream, undefined, 'el body de Anthropic no lleva stream');
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

// ═══ B11: prompt caching de Claude vía OpenRouter ═══════════════════════════

// Historial típico del loop agéntico: pedido + tool call + resultado.
const loopMessages = [
  { role: 'user', text: 'arreglá el bug' },
  { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'file_read', args: { path: 'x.ts' } }] },
  { role: 'tool', toolCallId: 'c1', toolName: 'file_read', result: 'contenido del archivo' },
];

test('OpenRouter+Claude: breakpoints de cache en system, último user y último tool', async () => {
  const { calls, restore } = stubFetch([fakeRes(200, openaiOk)]);
  try {
    await callModelWithTools({
      ...baseInput, providerId: 'openrouter', model: 'anthropic/claude-opus-4.8', messages: loopMessages,
    });
    const { body } = calls[0];
    // System multipart con cache_control (cachea tools+system).
    const sys = body.messages[0];
    assert.equal(sys.role, 'system');
    assert.ok(Array.isArray(sys.content), 'system debe ser multipart');
    assert.deepEqual(sys.content[0].cache_control, { type: 'ephemeral' });
    // Último user taggeado (ancla estable del historial).
    const user = body.messages[1];
    assert.ok(Array.isArray(user.content), 'user pasa a multipart para llevar el tag');
    assert.deepEqual(user.content[0].cache_control, { type: 'ephemeral' });
    assert.equal(user.content[0].text, 'arreglá el bug', 'el texto no cambia');
    // El assistant con tool_calls NO se toca (content null, sin tag).
    const assistant = body.messages[2];
    assert.equal(assistant.content, null);
    // Último mensaje (tool result) taggeado — cachea el loop que crece por el final.
    const toolMsg = body.messages[3];
    assert.equal(toolMsg.role, 'tool');
    assert.equal(toolMsg.tool_call_id, 'c1');
    assert.ok(Array.isArray(toolMsg.content));
    assert.deepEqual(toolMsg.content[0].cache_control, { type: 'ephemeral' });
    assert.equal(toolMsg.content[0].text, 'contenido del archivo');
  } finally { restore(); }
});

test('OpenRouter con modelo NO-Claude: payload intacto, sin cache_control', async () => {
  const { calls, restore } = stubFetch([fakeRes(200, openaiOk)]);
  try {
    await callModelWithTools({
      ...baseInput, providerId: 'openrouter', model: 'deepseek/deepseek-v3', messages: loopMessages,
    });
    const { body } = calls[0];
    assert.equal(typeof body.messages[0].content, 'string', 'system sigue siendo string');
    assert.equal(body.messages[1].content, 'arreglá el bug', 'user sigue siendo string');
    assert.equal(typeof body.messages[3].content, 'string', 'tool result sigue siendo string');
    assert.ok(!JSON.stringify(body).includes('cache_control'), 'sin cache_control en ninguna parte');
  } finally { restore(); }
});

test('otros proveedores OpenAI (nvidia): payload intacto, sin cache ni stream_options', async () => {
  const { calls, restore } = stubFetch([fakeRes(200, openaiOk)]);
  try {
    await callModelWithTools({ ...baseInput, providerId: 'nvidia', model: 'anthropic/claude-x' });
    const { body } = calls[0];
    assert.equal(typeof body.messages[0].content, 'string');
    assert.ok(!JSON.stringify(body).includes('cache_control'));
    assert.equal(body.stream_options, undefined);
  } finally { restore(); }
});

test('OpenRouter+Claude: si el payload con cache da 400, degrada a sin-cache y sigue', async () => {
  const { calls, restore } = stubFetch([
    fakeRes(400, { error: 'cache_control not supported here' }),
    fakeRes(200, openaiOk),
  ]);
  try {
    const reply = await callModelWithTools({
      ...baseInput, providerId: 'openrouter', model: 'anthropic/claude-opus-4.8', messages: loopMessages,
    });
    assert.equal(reply.text, 'listo', 'el chat no se rompe: responde igual');
    assert.equal(calls.length, 2, 'un intento con cache + uno sin');
    assert.ok(JSON.stringify(calls[0].body).includes('cache_control'), 'el 1º va con cache');
    assert.ok(!JSON.stringify(calls[1].body).includes('cache_control'), 'el 2º va limpio');
  } finally { restore(); }
});

// ── B11: usage/metricas de cache en la respuesta ─────────────────────────────
test('Anthropic reporta usage con tokens de cache', async () => {
  const withUsage = {
    ...anthropicOk,
    usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5000, cache_creation_input_tokens: 700 },
  };
  const { restore } = stubFetch([fakeRes(200, withUsage)]);
  try {
    const reply = await callModelWithTools({ ...baseInput, providerId: 'anthropic', model: 'claude-opus-4-8' });
    assert.deepEqual(reply.usage, { inputTokens: 12, outputTokens: 34, cacheReadTokens: 5000, cacheWriteTokens: 700 });
  } finally { restore(); }
});

test('OpenRouter streaming: pide include_usage y captura usage del chunk final', async () => {
  const chunks = [
    sse({ choices: [{ delta: { content: 'ok' } }] }),
    sse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } } }),
    'data: [DONE]\n\n',
  ];
  const { calls, restore } = stubFetch([sseRes(chunks)]);
  try {
    const reply = await callModelWithTools({
      ...baseInput, providerId: 'openrouter', model: 'anthropic/claude-opus-4.8', onTextDelta: () => {},
    });
    assert.deepEqual(calls[0].body.stream_options, { include_usage: true });
    assert.equal(reply.text, 'ok');
    assert.equal(reply.usage?.inputTokens, 100);
    assert.equal(reply.usage?.cacheReadTokens, 80);
  } finally { restore(); }
});

// ── memoización del 400 por thinking: solo se paga UNA vez por modelo ────────
test('un modelo sin thinking no repite el 400 en llamadas siguientes', async () => {
  const { calls, restore } = stubFetch([
    fakeRes(400, 'thinking is not supported on this model'),
    fakeRes(200, anthropicOk),
    fakeRes(200, anthropicOk),
  ]);
  try {
    const input = { ...baseInput, providerId: 'anthropic', model: 'claude-legacy-sin-thinking' };
    await callModelWithTools(input); // 400 + reintento sin thinking (2 calls)
    await callModelWithTools(input); // directo sin thinking (1 call)
    assert.equal(calls.length, 3);
    assert.ok(calls[0].body.thinking, 'el 1º intento va con thinking');
    assert.equal(calls[1].body.thinking, undefined, 'el reintento va sin thinking');
    assert.equal(calls[2].body.thinking, undefined, 'la llamada siguiente ya no paga el 400');
  } finally { restore(); }
});
