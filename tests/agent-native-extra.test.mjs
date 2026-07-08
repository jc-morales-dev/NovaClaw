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

console.log('agent-native-extra.test.mjs passed');
