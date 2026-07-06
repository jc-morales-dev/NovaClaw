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

  assert.equal(result.events[0].type, 'toolExecution');
  assert.equal(result.events[0].toolExecution.name, 'terminal.run');
  assert.match(result.events[0].toolExecution.output, /claw-agent-workspace/i);
  assert.deepEqual(result.events[1], {
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

console.log('agent-runtime.test.mjs passed');
