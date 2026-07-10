import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createNativeAgentRuntime } = await import('../src/agent/nativeAgent.ts');
const { createAgentSession } = await import('../src/agent/runtime.ts');
const { createLocalToolExecutor } = await import('../src/agent/tools.ts');

const noop = async (c) => ({ name: c.tool, command: '', status: 'success', output: 'ok', cwd: os.tmpdir() });

// ── Modo PLAN: las tools que mutan quedan bloqueadas ─────────────────────────
{
  let turn = 0;
  const fakeModel = async () => {
    turn += 1;
    if (turn === 1) return { toolCalls: [{ id: 'w', name: 'file_write', args: { path: 'x.txt', content: 'hola' } }] };
    return { text: 'Plan: 1) crear x.txt con "hola".' };
  };
  let executorCalls = 0;
  const runtime = createNativeAgentRuntime({
    workspaceRoot: os.tmpdir(),
    getConfig: () => ({ providerId: 'x', apiKey: 'x', model: 'm' }),
    executeToolCall: async (c) => { executorCalls += 1; return noop(c); },
    callModel: fakeModel,
  });
  const session = createAgentSession('plan', os.tmpdir());
  const result = await runtime.runUserTurn(session, 'planeá crear x.txt', undefined, undefined, 'plan');

  assert.equal(executorCalls, 0, 'file_write NO debe ejecutarse en modo plan');
  const toolEvents = result.events.filter((e) => e.type === 'toolExecution');
  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].toolExecution.status, 'error');
  assert.match(toolEvents[0].toolExecution.output, /PLAN MODE/);
}

// ── Modo BUILD: la misma tool SÍ se ejecuta ──────────────────────────────────
{
  let turn = 0;
  const fakeModel = async () => {
    turn += 1;
    if (turn === 1) return { toolCalls: [{ id: 'w', name: 'file_write', args: { path: 'x.txt', content: 'hola' } }] };
    return { text: 'Hecho.' };
  };
  let executorCalls = 0;
  const runtime = createNativeAgentRuntime({
    workspaceRoot: os.tmpdir(),
    getConfig: () => ({ providerId: 'x', apiKey: 'x', model: 'm' }),
    executeToolCall: async (c) => { executorCalls += 1; return noop(c); },
    callModel: fakeModel,
  });
  const session = createAgentSession('build', os.tmpdir());
  await runtime.runUserTurn(session, 'creá x.txt', undefined, undefined, 'build');
  assert.equal(executorCalls, 1, 'file_write SÍ se ejecuta en modo build');
}

// ── Journal de Deshacer: file.write/edit registran el estado previo ──────────
{
  const changes = [];
  const exec = createLocalToolExecutor({ onFileChange: (c) => changes.push(c) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-undo-'));
  const p = path.join(dir, 'a.txt');
  const ctx = { cwd: dir, workspaceRoot: dir };

  await exec({ tool: 'file.write', arguments: { path: p, content: 'v1' } }, ctx);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].existedBefore, false, 'primer write: el archivo no existía');
  assert.equal(changes[0].before, null);

  await exec({ tool: 'file.write', arguments: { path: p, content: 'v2' } }, ctx);
  assert.equal(changes.length, 2);
  assert.equal(changes[1].existedBefore, true);
  assert.equal(changes[1].before, 'v1', 'guarda el contenido previo para deshacer');

  await exec({ tool: 'file.edit', arguments: { path: p, old_string: 'v2', new_string: 'v3' } }, ctx);
  assert.equal(changes.length, 3);
  assert.equal(changes[2].before, 'v2', 'file.edit también registra el previo');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('agent-plan-undo.test.mjs passed');
