import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { createAgentRuntime, createAgentSession } = await import('../src/agent/runtime.ts');
const { createLocalToolExecutor } = await import('../src/agent/tools.ts');

const workspaceRoot = path.join(os.tmpdir(), 'claw-agent-workspace');
const externalRoot = path.join(os.tmpdir(), 'claw-agent-external');
await fs.mkdir(workspaceRoot, { recursive: true });
await fs.mkdir(externalRoot, { recursive: true });

{
  const executeToolCall = createLocalToolExecutor();
  const scriptedResponses = [
    '{"kind":"tool_call","tool":"terminal.run","arguments":{"command":"pwd"}}',
    '{"kind":"message","message":"I inspected the current directory."}',
  ];

  const runtime = createAgentRuntime({
    workspaceRoot,
    callModel: async () => scriptedResponses.shift() ?? '{"kind":"message","message":"no response"}',
    executeToolCall,
  });

  const session = createAgentSession('safe-session', workspaceRoot);
  const result = await runtime.runUserTurn(session, 'tell me where I am');

  // Todo comando de shell se detiene a pedir aprobación, incluso `pwd`.
  assert.equal(result.events[0].type, 'approval');
  assert.equal(session.pendingApproval?.toolCall.tool, 'terminal.run');

  const resumed = await runtime.resolveApproval(session, true);
  assert.equal(resumed.events[0].type, 'toolExecution');
  assert.equal(resumed.events[0].toolExecution.name, 'terminal.run');
  assert.match(resumed.events[0].toolExecution.output, /claw-agent-workspace/i);
  assert.deepEqual(resumed.events[1], {
    type: 'message',
    message: 'I inspected the current directory.',
  });
}

{
  const executeToolCall = createLocalToolExecutor();
  const targetPath = path.join(externalRoot, 'note.txt');
  await fs.rm(targetPath, { force: true });

  const scriptedResponses = [
    JSON.stringify({
      kind: 'tool_call',
      tool: 'file.write',
      arguments: {
        path: targetPath,
        content: 'hello from agent',
      },
    }),
    '{"kind":"message","message":"File created after your confirmation."}',
  ];

  const runtime = createAgentRuntime({
    workspaceRoot,
    callModel: async () => scriptedResponses.shift() ?? '{"kind":"message","message":"no response"}',
    executeToolCall,
  });

  const session = createAgentSession('approval-session', workspaceRoot);
  const paused = await runtime.runUserTurn(session, 'create a file outside the workspace');

  assert.equal(paused.events[0].type, 'approval');
  assert.equal(session.pendingApproval?.toolCall.tool, 'file.write');

  const resumed = await runtime.resolveApproval(session, true);
  assert.equal(resumed.events[0].type, 'toolExecution');
  assert.equal(resumed.events[0].toolExecution.name, 'file.write');
  assert.equal(await fs.readFile(targetPath, 'utf8'), 'hello from agent');
  assert.deepEqual(resumed.events[1], {
    type: 'message',
    message: 'File created after your confirmation.',
  });
}

{
  const executeToolCall = createLocalToolExecutor();
  let callCount = 0;

  const runtime = createAgentRuntime({
    workspaceRoot,
    maxParseRetries: 1,
    callModel: async () => {
      callCount += 1;
      if (callCount === 1) return 'this is not json';
      return '{"kind":"message","message":"Recovered after repair."}';
    },
    executeToolCall,
  });

  const session = createAgentSession('repair-session', workspaceRoot);
  const result = await runtime.runUserTurn(session, 'test repair');

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'message');
  assert.equal(result.events[0].message, 'Recovered after repair.');
  assert.equal(callCount, 2);
}

{
  const executeToolCall = createLocalToolExecutor();
  const runtime = createAgentRuntime({
    workspaceRoot,
    callModel: async () => '{"kind":"message","message":"No pending approval."}',
    executeToolCall,
  });

  const session = createAgentSession('no-approval-session', workspaceRoot);
  const result = await runtime.resolveApproval(session, true);

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'message');
  assert.match(result.events[0].message, /pending/i);
}

{
  const executeToolCall = createLocalToolExecutor();
  const targetPath = path.join(externalRoot, 'rejected.txt');
  await fs.rm(targetPath, { force: true });

  const scriptedResponses = [
    JSON.stringify({
      kind: 'tool_call',
      tool: 'file.write',
      arguments: {
        path: targetPath,
        content: 'should not be written',
      },
    }),
    '{"kind":"message","message":"Understood, I will not write that file."}',
  ];

  const runtime = createAgentRuntime({
    workspaceRoot,
    callModel: async () => scriptedResponses.shift() ?? '{"kind":"message","message":"no response"}',
    executeToolCall,
  });

  const session = createAgentSession('reject-session', workspaceRoot);
  const paused = await runtime.runUserTurn(session, 'write a file outside workspace');
  assert.equal(paused.events[0].type, 'approval');

  const resumed = await runtime.resolveApproval(session, false);
  assert.equal(resumed.events[resumed.events.length - 1].type, 'message');
  assert.equal(resumed.events[resumed.events.length - 1].message, 'Understood, I will not write that file.');

  const exists = await fs.access(targetPath).then(() => true, () => false);
  assert.equal(exists, false, 'File should NOT exist after rejection');
}

{
  // Plan no depende de que el modelo obedezca el prompt: el runtime legacy
  // bloquea la mutación antes de llegar al executor.
  let executorCalls = 0;
  const scriptedResponses = [
    JSON.stringify({ kind: 'tool_call', tool: 'file.write', arguments: { path: 'plan.txt', content: 'no' } }),
    '{"kind":"message","message":"Solo propongo el cambio."}',
  ];
  const runtime = createAgentRuntime({
    workspaceRoot,
    callModel: async () => scriptedResponses.shift() ?? '{"kind":"message","message":"fin"}',
    executeToolCall: async () => {
      executorCalls += 1;
      throw new Error('Plan no debe invocar el executor para mutaciones');
    },
  });
  const session = createAgentSession('plan-legacy', workspaceRoot);
  const result = await runtime.runUserTurn(session, 'solo planificá', undefined, undefined, 'plan');
  assert.equal(executorCalls, 0);
  assert.equal(result.events[0].type, 'toolExecution');
  assert.match(result.events[0].toolExecution.output, /PLAN MODE/);
  assert.equal(result.events.at(-1).type, 'message');
}

{
  // Regresión de carrera: el runtime es singleton. Un turno Auto concurrente no
  // puede sobrescribir el modo de un turno Plan que está esperando al modelo.
  let releasePlan;
  let signalPlanEntered;
  const planEntered = new Promise((resolve) => { signalPlanEntered = resolve; });
  const planGate = new Promise((resolve) => { releasePlan = resolve; });
  let modelCalls = 0;
  const executed = [];
  const runtime = createAgentRuntime({
    workspaceRoot,
    callModel: async () => {
      modelCalls += 1;
      if (modelCalls === 1) {
        signalPlanEntered();
        await planGate;
        return JSON.stringify({ kind: 'tool_call', tool: 'file.write', arguments: { path: 'race.txt', content: 'no' } });
      }
      if (modelCalls === 2) return '{"kind":"message","message":"auto terminó"}';
      return '{"kind":"message","message":"plan terminó"}';
    },
    executeToolCall: async (call) => {
      executed.push(call.tool);
      return { name: call.tool, command: '', status: 'success', output: 'ejecutado', cwd: workspaceRoot };
    },
  });
  const planSession = createAgentSession('plan-race', workspaceRoot);
  const autoSession = createAgentSession('auto-race', workspaceRoot);
  const planPromise = runtime.runUserTurn(planSession, 'planificá', undefined, undefined, 'plan');
  await planEntered;
  await runtime.runUserTurn(autoSession, 'hacé', undefined, undefined, 'auto');
  releasePlan();
  const planResult = await planPromise;
  assert.deepEqual(executed, [], 'Auto concurrente no cambia el modo inmutable del turno Plan');
  assert.match(planResult.events[0].toolExecution.output, /PLAN MODE/);
}

console.log('agent-runtime.test.mjs passed');
