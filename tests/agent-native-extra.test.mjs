import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

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
    if (/compress a coding-agent conversation/i.test(system ?? '')) {
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

// ── B9: compacta por TOKENS aunque haya pocas entradas (pero enormes) ─────────
{
  let summaryAsked = false;
  const fakeModel = async ({ system }) => {
    if (/compress a coding-agent conversation/i.test(system ?? '')) {
      summaryAsked = true;
      return { text: 'RESUMEN.' };
    }
    return { text: 'Respuesta final.' };
  };
  const runtime = createNativeAgentRuntime({
    workspaceRoot: os.tmpdir(),
    getConfig: () => ({ providerId: 'x', apiKey: 'x', model: 'm' }),
    executeToolCall: noopExecutor,
    callModel: fakeModel,
  });
  const session = createAgentSession('bigtokens', os.tmpdir());
  // Pocas entradas (30 < umbral 44) pero ENORMES: ~112k tokens > umbral 100k.
  for (let i = 0; i < 30; i++) {
    session.history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(15000) });
  }
  const before = session.history.length;
  await runtime.runUserTurn(session, 'seguí');
  assert.ok(summaryAsked, 'debe compactar por tokens aunque haya pocas entradas');
  assert.ok(session.history.length < before, `debe encogerse (antes ${before}, ahora ${session.history.length})`);
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

// ── anti-loop: la MISMA llamada repetida se corta a la 3ª sin re-ejecutar ─────
{
  let turn = 0;
  const fakeModel = async () => {
    turn += 1;
    // El modelo insiste con la MISMA tool y args (loop típico de modelo débil).
    if (turn <= 4) return { toolCalls: [{ id: 't' + turn, name: 'terminal_run', args: { command: 'ls' } }] };
    return { text: 'Listo.' };
  };
  let executorCalls = 0;
  const runtime = createNativeAgentRuntime({
    workspaceRoot: os.tmpdir(),
    getConfig: () => ({ providerId: 'x', apiKey: 'x', model: 'm' }),
    executeToolCall: async (c) => { executorCalls += 1; return noopExecutor(c); },
    callModel: fakeModel,
  });
  const session = createAgentSession('loop', os.tmpdir());
  const result = await runtime.runUserTurn(session, 'corré ls');
  // Las 2 primeras corren de verdad; de la 3ª en adelante se cortan con aviso.
  assert.equal(executorCalls, 2, `solo 2 ejecuciones reales, no ${executorCalls}`);
  const warned = result.events.some(
    (e) => e.type === 'toolExecution' && /MISMA llamada/i.test(e.toolExecution.output || ''),
  );
  assert.ok(warned, 'debe avisar del loop');
}

// ── tool inexistente: se guía al modelo sin llamar al executor ────────────────
{
  let turn = 0;
  const fakeModel = async () => {
    turn += 1;
    if (turn === 1) return { toolCalls: [{ id: 'u1', name: 'magic_do_everything', args: {} }] };
    return { text: 'ok' };
  };
  let executorCalls = 0;
  const runtime = createNativeAgentRuntime({
    workspaceRoot: os.tmpdir(),
    getConfig: () => ({ providerId: 'x', apiKey: 'x', model: 'm' }),
    executeToolCall: async (c) => { executorCalls += 1; return noopExecutor(c); },
    callModel: fakeModel,
  });
  const session = createAgentSession('unknown', os.tmpdir());
  const result = await runtime.runUserTurn(session, 'hacé magia');
  assert.equal(executorCalls, 0, 'una tool inexistente no debe llegar al executor');
  const hint = result.events.some(
    (e) => e.type === 'toolExecution' && /no existe/i.test(e.toolExecution.output || ''),
  );
  assert.ok(hint, 'debe guiar al modelo con las tools válidas');
}

// ── B3: empuja a verificar tras editar código sin correr diagnostics ─────────
{
  const wsRoot = os.tmpdir();
  const codePath = path.join(wsRoot, 'verify-x.ts');
  let turn = 0;
  let sawNudge = false;
  const fakeModel = async ({ messages }) => {
    turn += 1;
    if (turn === 1) {
      return { toolCalls: [{ id: 'e1', name: 'file_edit', args: { path: codePath, old_string: 'a', new_string: 'b' } }] };
    }
    if (messages.some((m) => typeof m.text === 'string' && /no lo verificaste/i.test(m.text))) sawNudge = true;
    return { text: 'Listo (respuesta final).' };
  };
  const runtime = createNativeAgentRuntime({
    workspaceRoot: wsRoot,
    getConfig: () => ({ providerId: 'x', apiKey: 'x', model: 'm' }),
    executeToolCall: async (c) => ({ name: c.tool, command: String(c.arguments?.path ?? ''), status: 'success', output: 'ok', cwd: wsRoot }),
    callModel: fakeModel,
  });
  const session = createAgentSession('verify', wsRoot);
  const result = await runtime.runUserTurn(session, 'editá verify-x.ts');
  assert.ok(sawNudge, 'debe empujar a verificar tras editar código sin diagnostics');
  assert.ok(turn >= 3, `debe reintentar el turno tras el aviso (turnos: ${turn})`);
  const msgs = result.events.filter((e) => e.type === 'message');
  assert.equal(msgs[msgs.length - 1].message, 'Listo (respuesta final).');
}

// ── B3: si corre diagnostics tras editar, NO molesta (no empuja de más) ───────
{
  const wsRoot = os.tmpdir();
  const codePath = path.join(wsRoot, 'verify-y.ts');
  let turn = 0;
  let sawNudge = false;
  const fakeModel = async ({ messages }) => {
    turn += 1;
    if (turn === 1) return { toolCalls: [{ id: 'e1', name: 'file_edit', args: { path: codePath, old_string: 'a', new_string: 'b' } }] };
    if (turn === 2) return { toolCalls: [{ id: 'd1', name: 'diagnostics', args: { path: codePath } }] };
    if (messages.some((m) => typeof m.text === 'string' && /no lo verificaste/i.test(m.text))) sawNudge = true;
    return { text: 'Verificado y listo.' };
  };
  const runtime = createNativeAgentRuntime({
    workspaceRoot: wsRoot,
    getConfig: () => ({ providerId: 'x', apiKey: 'x', model: 'm' }),
    executeToolCall: async (c) => ({ name: c.tool, command: String(c.arguments?.path ?? ''), status: 'success', output: 'ok', cwd: wsRoot }),
    callModel: fakeModel,
  });
  const session = createAgentSession('verify2', wsRoot);
  await runtime.runUserTurn(session, 'editá y verificá verify-y.ts');
  assert.ok(!sawNudge, 'no debe empujar si ya corrió diagnostics');
}

// ── B8: dos subagent_run en el mismo turno corren EN PARALELO ────────────────
{
  let active = 0;
  let maxActive = 0;
  let mainTurn = 0;
  const fakeModel = async ({ system }) => {
    if (/You are a NovaClaw sub-agent/i.test(system ?? '')) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      return { text: 'reporte del subagente' };
    }
    mainTurn += 1;
    if (mainTurn === 1) {
      return { toolCalls: [
        { id: 's1', name: 'subagent_run', args: { task: 'explorá A' } },
        { id: 's2', name: 'subagent_run', args: { task: 'explorá B' } },
      ] };
    }
    return { text: 'síntesis final.' };
  };
  const runtime = createNativeAgentRuntime({
    workspaceRoot: os.tmpdir(),
    getConfig: () => ({ providerId: 'x', apiKey: 'x', model: 'm' }),
    executeToolCall: async (c) => ({ name: c.tool, command: '', status: 'success', output: 'ok', cwd: os.tmpdir() }),
    callModel: fakeModel,
  });
  const session = createAgentSession('fanout', os.tmpdir());
  const result = await runtime.runUserTurn(session, 'explorá A y B');
  assert.equal(maxActive, 2, `los 2 subagentes deben correr en paralelo (maxActive=${maxActive})`);
  const subEvents = result.events.filter((e) => e.type === 'toolExecution' && e.toolExecution.name === 'subagent.run');
  assert.equal(subEvents.length, 2, 'deben registrarse 2 reportes de subagente');
}

console.log('agent-native-extra.test.mjs passed');
