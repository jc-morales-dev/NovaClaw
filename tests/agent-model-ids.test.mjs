/**
 * Los IDs de modelo son texto libre que viene del catálogo del proveedor, y de
 * ahí salen tres decisiones por regex: si mandar temperature, si mandar effort y
 * si usar adaptive thinking. Un match equivocado no degrada: rompe el chat con
 * un 400. OpenRouter además escribe la versión con punto y le cuelga sufijos
 * (:free, :beta, :nitro), así que acá se prueba con nombres REALES de catálogo.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { callModelWithTools } = await import('../src/agent/modelClient.ts');

function fakeRes(status, body) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
function stubFetch(queue) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    let body = {};
    try { body = JSON.parse(init?.body ?? '{}'); } catch { /* noop */ }
    calls.push({ url, body });
    return queue.shift() ?? fakeRes(200, { choices: [{ message: { content: 'ok' } }] });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const base = { apiKey: 'k', system: 's', messages: [{ role: 'user', text: 'hola' }] };

/** Devuelve el body que se le mandó al proveedor para ese modelo. */
async function bodyFor(providerId, model, extra = {}) {
  const ok = providerId === 'anthropic'
    ? fakeRes(200, { content: [{ type: 'text', text: 'ok' }] })
    : fakeRes(200, { choices: [{ message: { content: 'ok' } }] });
  const { calls, restore } = stubFetch([ok]);
  try {
    await callModelWithTools({ ...base, providerId, model, ...extra });
    return calls[0].body;
  } finally { restore(); }
}

// ── temperature: los modelos que la eliminaron devuelven 400 si viaja ────────
test('temperature se omite en TODAS las formas de escribir un modelo sin sampling', async () => {
  const sinSampling = [
    'anthropic/claude-opus-4.8',
    'anthropic/claude-opus-4.8:beta',      // OpenRouter le cuelga sufijos
    'anthropic/claude-opus-4.7',
    'anthropic/claude-sonnet-5',
    'anthropic/claude-sonnet-5:nitro',
    'claude-fable-5',
    'claude-mythos-5',
  ];
  for (const m of sinSampling) {
    const body = await bodyFor('openrouter', m);
    assert.equal(body.temperature, undefined, `${m} NO debe llevar temperature`);
  }
});

test('temperature se conserva en los modelos que sí la aceptan', async () => {
  const conSampling = [
    'anthropic/claude-opus-4.6',
    'anthropic/claude-sonnet-4.6',
    'anthropic/claude-haiku-4-5',
    'minimaxai/minimax-m3',
    'deepseek/deepseek-r1:free',
    'z-ai/glm-5.2',
    'openai/gpt-5.4',
  ];
  for (const m of conSampling) {
    const body = await bodyFor('openrouter', m);
    assert.equal(body.temperature, 0.2, `${m} SÍ debe llevar temperature`);
  }
});

// Un modelo con un número pegado no debe confundirse con la versión soportada.
test('no hay falsos positivos por coincidencia parcial de versión', async () => {
  const body = await bodyFor('openrouter', 'vendor/modelo-opus-4-80');
  assert.equal(body.temperature, 0.2, 'opus-4-80 no es opus-4-8');
});

// ── effort: solo donde existe, o el modelo devuelve 400 ──────────────────────
test('effort viaja solo en los modelos que lo soportan', async () => {
  const soporta = ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-fable-5'];
  for (const m of soporta) {
    const body = await bodyFor('anthropic', m, { effort: 'medium' });
    assert.deepEqual(body.output_config, { effort: 'medium' }, `${m} soporta effort`);
  }

  const noSoporta = ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-3-haiku-20240307'];
  for (const m of noSoporta) {
    const body = await bodyFor('anthropic', m, { effort: 'medium' });
    assert.equal(body.output_config, undefined, `${m} devuelve 400 si le mandás effort`);
  }
});

test('sin effort configurado no se manda output_config', async () => {
  const body = await bodyFor('anthropic', 'claude-opus-4-8');
  assert.equal(body.output_config, undefined);
});

// ── thinking: adaptive vs budget_tokens ─────────────────────────────────────
test('adaptive thinking en 4.6+ y budget_tokens en los previos', async () => {
  for (const m of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5', 'claude-sonnet-4-6']) {
    const body = await bodyFor('anthropic', m);
    assert.deepEqual(body.thinking, { type: 'adaptive' }, `${m} usa adaptive`);
  }
  const haiku = await bodyFor('anthropic', 'claude-haiku-4-5');
  assert.equal(haiku.thinking?.type, 'enabled', 'Haiku 4.5 sigue con budget_tokens');
  assert.ok(haiku.thinking?.budget_tokens > 0);
  assert.ok(haiku.thinking.budget_tokens < haiku.max_tokens, 'budget_tokens debe ser menor que max_tokens');
});

// ── max_tokens: el techo sube solo cuando hay streaming ─────────────────────
test('max_tokens sube con streaming y se queda bajo sin él', async () => {
  const sinStream = await bodyFor('anthropic', 'claude-opus-4-8');
  const conStream = await bodyFor('anthropic', 'claude-opus-4-8', { onTextDelta: () => {} });
  assert.ok(conStream.max_tokens > sinStream.max_tokens, 'con streaming se puede pedir más salida');
  assert.ok(sinStream.max_tokens <= 16384, 'sin streaming hay que quedarse bajo el timeout HTTP');
});

// ── Mensajes de error: el usuario tiene que entender QUÉ hacer ───────────────
// El 429 de los niveles gratuitos caía en el mensaje de red y mandaba a revisar
// el wifi con el wifi andando. Medido en un teléfono real contra NVIDIA free.
const { friendlyModelError } = await import('../src/agent/nativeAgentSupport.ts');

test('429 se explica como cuota, no como problema de conexión', () => {
  const m = friendlyModelError(new Error('Modelo 429: {"status":429,"title":"Too Many Requests"}'), 'k');
  assert.match(m, /l[íi]mite|cuota/i, 'debe hablar de límite/cuota');
  assert.doesNotMatch(m, /conexi[óo]n a internet/i, 'NO debe mandar a revisar internet');
});

test('sobrecarga del proveedor no se confunde con key inválida', () => {
  const m = friendlyModelError(new Error('Anthropic 529: overloaded_error'), 'k');
  assert.match(m, /sobrecarg/i);
  assert.doesNotMatch(m, /API key/i);
});

test('401 sigue señalando la API key', () => {
  const m = friendlyModelError(new Error('Modelo 401: unauthorized'), 'k');
  assert.match(m, /API key/i);
});

test('un 400 de validación no se disfraza de key inválida', () => {
  const m = friendlyModelError(new Error('Anthropic 400: invalid_request_error: temperature no soportado'), 'k');
  assert.doesNotMatch(m, /API key no es válida/i, 'la palabra "invalid" no debe implicar key mala');
});

test('sin API key el mensaje lleva a configurar', () => {
  const m = friendlyModelError(new Error('cualquier cosa'), '');
  assert.match(m, /API key/i);
});
