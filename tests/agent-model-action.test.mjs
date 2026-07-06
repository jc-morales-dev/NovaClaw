import assert from 'node:assert/strict';

const { extractModelAction, tryParseJson, validateAction } = await import('../src/agent/modelAction.ts');

const messageAction = extractModelAction('{"kind":"message","message":"hola"}');
assert.deepEqual(messageAction, {
  kind: 'message',
  message: 'hola',
});

const toolAction = extractModelAction('```json\n{"kind":"tool_call","tool":"terminal.run","arguments":{"command":"ls"}}\n```');
assert.equal(toolAction.kind, 'tool_call');
assert.equal(toolAction.tool, 'terminal.run');
assert.deepEqual(toolAction.arguments, { command: 'ls' });

assert.throws(
  () => extractModelAction('hola sin json'),
  /valid JSON action/i,
);

const parsed = tryParseJson('not json at all');
assert.equal(parsed, null);

const validParsed = tryParseJson('{"kind":"message","message":"test"}');
assert.deepEqual(validateAction(validParsed), { kind: 'message', message: 'test' });

assert.equal(validateAction(null), null);
assert.equal(validateAction({}), null);
assert.equal(validateAction({ kind: 'unknown' }), null);

const toolWithArrayArgs = validateAction({ kind: 'tool_call', tool: 'test', arguments: [1, 2] });
assert.equal(toolWithArrayArgs, null);

console.log('agent-model-action.test.mjs passed');
