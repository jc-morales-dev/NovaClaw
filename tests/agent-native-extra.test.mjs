import assert from 'node:assert/strict';
import os from 'node:os';

const { createNativeAgentRuntime } = await import('../src/agent/nativeAgent.ts');
const { createAgentSession } = await import('../src/agent/runtime.ts');

const noopExecutor = async (call) => ({
  name: call.tool, command: '', status: 'success', output: 'ok', cwd: os.tmpdir(),
});

// ── todo_write: emite un evento 'todo' y NO va al executor ────────────────────
{
  let turn = 0;
  const fakeModel = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        toolCalls: [{
          id: 'p1', name: 'todo_write',
          args: { todos: [
            { content: 'Paso uno', status: 'in_progress' },
            { content: 'Paso dos', status: 'pending' },
          ] },
        }],
      };
    }
    return { text: 'Listo.' };
  };

  let executorCalls = 0;
  const runtime = createNativeAgentRuntime({
    workspaceRoot: os.tmpdir(),
    getConfig: () => ({ providerId: 'openrouter', apiKey: 'x', model: 'm' }),
    executeToolCall: async (c) => { executorCalls += 1; return noopExecutor(c); },
    callModel: fakeModel,
  });
  const session = createAgentSession('todo', os.tmpdir());
  const result = await runtime.runUserTurn(session, 'hacé un plan');

  const todoEvents = result.events.filter((e) => e.type === 'todo');
  assert.equal(todoEvents.length, 1, 'debe emitir un evento todo');
  assert.equal(todoEvents[0].todos.length, 2);
  assert.equal(todoEvents[0].todos[0].status, 'in_progress');
  assert.equal(executorCalls, 0, 'todo_write NO debe llegar al executor');
}

// ── todo_write: normaliza estados inválidos a pending y descarta vacíos ────────
{
  let turn = 0;
  const fakeModel = async () => {
    turn += 1;
    if (turn === 1) {
      return { toolCalls: [{ id: 'p1', name: 'todo_write', args: { todos: [
        { content: 'valido', status: 'bogus' },
        { content: '', status: 'pending' },
      ] } }] };
    }
    return { text: 'ok' };
  };
  const runtime = createNativeAgentRuntime({
    workspaceRoot: os.tmpdir(),
    getConfig: () => ({ providerId: 'x', apiKey: 'x', model: 'm' }),
    executeToolCall: noopExecutor,
    callModel: fakeModel,
  });
  const session = createAgentSession('todo2', os.tmpdir());
  const result = await runtime.runUserTurn(session, 'plan');
  const todos = result.events.find((e) => e.type === 'todo').todos;
  assert.equal(todos.length, 1, 'descarta el vacío');
  assert.equal(todos[0].status, 'pending', 'normaliza estado inválido');
}

// ── compactación con resumen del modelo: historial largo se resume ────────────
{
  // callModel se usa para el resumen (una llamada extra sin toolCalls) y para el turno.
  let summaryAsked = false;
  const fakeModel = async ({ system, messages }) => {
    if (/compress an agent conversation/i.test(system ?? '')) {
      summaryAsked = true;
      return { text: 'RESUMEN: el usuario pidió varias cosas; se crearon archivos X e Y.' };
    }
    return { text: 'Respuesta final.' };
  };
  const runtime = createNativeAgentRuntime({
    workspaceRoot: os.tmpdir(),
    getConfig: () => ({ providerId: 'x', apiKey: 'x', model: 'm' }),
    executeToolCall: noopExecutor,
    callModel: fakeModel,
  });
  const session = createAgentSession('big', os.tmpdir());
  // Rellenamos un historial largo (> umbral 44).
  for (let i = 0; i < 60; i++) {
    session.history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `mensaje viejo ${i}` });
  }
  const before = session.history.length;
  await runtime.runUserTurn(session, 'seguí');

  assert.ok(summaryAsked, 'debe pedir un resumen al modelo');
  assert.ok(session.history.length < before, `el historial debe encogerse (antes ${before}, ahora ${session.history.length})`);
  const hasSummary = session.history.some((e) => {
    try { return JSON.parse(e.content).kind === 'history_summary'; } catch { return false; }
  });
  assert.ok(hasSummary, 'debe quedar una entrada de resumen');
}

// ── narración intermedia NO se muestra ni se guarda: una sola respuesta final ──
{
  // Turno 1: el modelo "narra" (texto) mientras llama una tool. Turno 2: idem.
  // Turno 3: respuesta final SIN tools. El usuario debe ver UN solo mensaje.
  let turn = 0;
  const fakeModel = async () => {
    turn += 1;
    if (turn === 1) {
      return { text: 'Buscando contactos…', toolCalls: [{ id: 'a', name: 'phone_contacts', args: { query: 'Roxy' } }] };
    }
    if (turn === 2) {
      return { text: 'No encontré, sigo buscando…', toolCalls: [{ id: 'b', name: 'phone_contacts', args: { query: '' } }] };
    }
    return { text: 'Acá está el resultado final.' };
  };
  const runtime = createNativeAgentRuntime({
    workspaceRoot: os.tmpdir(),
    getConfig: () => ({ providerId: 'x', apiKey: 'x', model: 'm' }),
    executeToolCall: noopExecutor,
    callModel: fakeModel,
  });
  const session = createAgentSession('single-answer', os.tmpdir());
  const result = await runtime.runUserTurn(session, 'buscá a Roxy');

  const messageEvents = result.events.filter((e) => e.type === 'message');
  assert.equal(messageEvents.length, 1, 'solo debe emitirse UN mensaje (la respuesta final)');
  assert.equal(messageEvents[0].message, 'Acá está el resultado final.');
  // La narración intermedia no debe quedar guardada como respuesta del asistente.
  const assistantEntries = session.history.filter((e) => e.role === 'assistant');
  assert.equal(assistantEntries.length, 1, 'solo la respuesta final va al historial');
  assert.ok(!session.history.some((e) => e.role === 'assistant' && /sigo buscando/i.test(e.content)),
    'la cháchara intermedia no debe persistirse');
  // Las tools sí se muestran (los chips de ejecución).
  assert.equal(result.events.filter((e) => e.type === 'toolExecution').length, 2, 'los 2 tool calls sí se muestran');
}

console.log('agent-native-extra.test.mjs passed');
