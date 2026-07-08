import assert from 'node:assert/strict';
import os from 'node:os';

const { createNativeAgentRuntime } = await import('../src/agent/nativeAgent.ts');
const { createAgentSession } = await import('../src/agent/runtime.ts');

// Modelo simulado (inyectado): turno 1 pide 3 file_read; turno 2 cierra.
let turn = 0;
const fakeModel = async () => {
  turn += 1;
  if (turn === 1) {
    return {
      toolCalls: [
        { id: 't1', name: 'file_read', args: { path: 'a.txt' } },
        { id: 't2', name: 'file_read', args: { path: 'b.txt' } },
        { id: 't3', name: 'file_read', args: { path: 'c.txt' } },
      ],
    };
  }
  return { text: 'Listo.' };
};

// Executor que mide concurrencia (las read-only deben solaparse).
let active = 0;
let maxActive = 0;
const executor = async (call) => {
  active += 1;
  maxActive = Math.max(maxActive, active);
  await new Promise((r) => setTimeout(r, 60));
  active -= 1;
  return { name: call.tool, command: '', status: 'success', output: `ok ${call.arguments.path}`, cwd: os.tmpdir() };
};

const runtime = createNativeAgentRuntime({
  workspaceRoot: os.tmpdir(),
  getConfig: () => ({ providerId: 'openrouter', apiKey: 'x', model: 'm' }),
  executeToolCall: executor,
  callModel: fakeModel,
});

const session = createAgentSession('parallel', os.tmpdir());
const result = await runtime.runUserTurn(session, 'leé los 3 archivos');

const toolEvents = result.events.filter((e) => e.type === 'toolExecution');
assert.equal(toolEvents.length, 3, 'debe haber 3 resultados de tool');
assert.ok(maxActive >= 2, `las read-only deben solaparse en paralelo (maxActive=${maxActive})`);
// El orden de registro se preserva aunque corran en paralelo.
assert.match(toolEvents[0].toolExecution.output, /a\.txt/);
assert.match(toolEvents[1].toolExecution.output, /b\.txt/);
assert.match(toolEvents[2].toolExecution.output, /c\.txt/);

// Un segundo caso: una tool que MUTA no debe agruparse con read-only.
turn = 0;
maxActive = 0;
active = 0;
let seq = 0;
const fakeModel2 = async () => {
  turn += 1;
  if (turn === 1) {
    return {
      toolCalls: [
        { id: 'w1', name: 'file_write', args: { path: 'x.txt', content: 'a' } },
        { id: 'w2', name: 'file_write', args: { path: 'y.txt', content: 'b' } },
      ],
    };
  }
  return { text: 'ok' };
};
const seqExecutor = async (call) => {
  active += 1;
  maxActive = Math.max(maxActive, active);
  await new Promise((r) => setTimeout(r, 30));
  active -= 1;
  seq += 1;
  return { name: call.tool, command: '', status: 'success', output: `w ${call.arguments.path}`, cwd: os.tmpdir() };
};
const runtime2 = createNativeAgentRuntime({
  workspaceRoot: os.tmpdir(),
  getConfig: () => ({ providerId: 'openrouter', apiKey: 'x', model: 'm' }),
  executeToolCall: seqExecutor,
  callModel: fakeModel2,
});
const session2 = createAgentSession('seq', os.tmpdir());
await runtime2.runUserTurn(session2, 'escribí 2 archivos');
assert.equal(maxActive, 1, `las tools que mutan deben ejecutarse de a una (maxActive=${maxActive})`);

console.log('agent-parallel.test.mjs passed');
