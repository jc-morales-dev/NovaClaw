import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { classifyToolCall } = await import('../src/agent/safety.ts');
const { createLocalToolExecutor } = await import('../src/agent/tools.ts');

const workspaceRoot = '/workspace/project';

const safeShell = classifyToolCall(
  {
    tool: 'terminal.run',
    arguments: { command: 'ls -la', cwd: workspaceRoot },
  },
  { cwd: workspaceRoot, workspaceRoot },
);
assert.equal(safeShell.requiresApproval, false);

const destructiveShell = classifyToolCall(
  {
    tool: 'terminal.run',
    arguments: { command: 'rm -rf tmp', cwd: workspaceRoot },
  },
  { cwd: workspaceRoot, workspaceRoot },
);
assert.equal(destructiveShell.requiresApproval, true);
assert.match(destructiveShell.reason, /sensitive/i);

const outsideWorkspaceWrite = classifyToolCall(
  {
    tool: 'file.write',
    arguments: { path: '/storage/downloads/file.txt', content: 'hello' },
  },
  { cwd: workspaceRoot, workspaceRoot },
);
assert.equal(outsideWorkspaceWrite.requiresApproval, true);
assert.match(outsideWorkspaceWrite.summary, /file\.write/i);

{
  const npmInstall = classifyToolCall(
    {
      tool: 'terminal.run',
      arguments: { command: 'npm install express' },
    },
    { cwd: workspaceRoot, workspaceRoot },
  );
  assert.equal(npmInstall.requiresApproval, true);

  const curlCommand = classifyToolCall(
    {
      tool: 'terminal.run',
      arguments: { command: 'curl https://example.com' },
    },
    { cwd: workspaceRoot, workspaceRoot },
  );
  assert.equal(curlCommand.requiresApproval, true);

  const insideWorkspaceWrite = classifyToolCall(
    {
      tool: 'file.write',
      arguments: { path: '/workspace/project/src/index.ts', content: 'console.log(1)' },
    },
    { cwd: workspaceRoot, workspaceRoot },
  );
  assert.equal(insideWorkspaceWrite.requiresApproval, false);

  const relativeWorkspaceWrite = classifyToolCall(
    {
      tool: 'file.write',
      arguments: { path: 'src/app.ts', content: 'console.log(2)' },
    },
    { cwd: workspaceRoot, workspaceRoot },
  );
  assert.equal(relativeWorkspaceWrite.requiresApproval, false);

  const insideWorkspaceMkdir = classifyToolCall(
    {
      tool: 'workspace.mkdir',
      arguments: { path: '/workspace/project/src/utils' },
    },
    { cwd: workspaceRoot, workspaceRoot },
  );
  assert.equal(insideWorkspaceMkdir.requiresApproval, false);

  const outsideWorkspaceMkdir = classifyToolCall(
    {
      tool: 'workspace.mkdir',
      arguments: { path: '/tmp/evil-dir' },
    },
    { cwd: workspaceRoot, workspaceRoot },
  );
  assert.equal(outsideWorkspaceMkdir.requiresApproval, true);
}

{
  const testDir = path.join(os.tmpdir(), 'claw-search-test');
  await fs.rm(testDir, { force: true, recursive: true });
  await fs.mkdir(path.join(testDir, 'src', 'components'), { recursive: true });
  await fs.mkdir(path.join(testDir, 'src', 'utils'), { recursive: true });
  await fs.writeFile(path.join(testDir, 'src', 'app.tsx'), 'app', 'utf8');
  await fs.writeFile(path.join(testDir, 'src', 'components', 'Button.tsx'), 'btn', 'utf8');
  await fs.writeFile(path.join(testDir, 'src', 'utils', 'helpers.ts'), 'help', 'utf8');
  await fs.writeFile(path.join(testDir, 'README.md'), 'readme', 'utf8');

  const execute = createLocalToolExecutor();
  const result = await execute(
    { tool: 'file.search', arguments: { path: testDir, query: '.tsx' } },
    { cwd: testDir, workspaceRoot: testDir },
  );

  assert.equal(result.status, 'success');
  assert.match(result.output, /app\.tsx/);
  assert.match(result.output, /Button\.tsx/);
  assert.doesNotMatch(result.output, /helpers\.ts/);
  assert.doesNotMatch(result.output, /README\.md/);
}

// ── Bypasses de la lista negra ahora bloqueados (H2) ─────────────────────────
{
  const mustApprove = (command) =>
    classifyToolCall({ tool: 'terminal.run', arguments: { command } }, { cwd: workspaceRoot, workspaceRoot }).requiresApproval;

  assert.equal(mustApprove('python3 -c "import shutil; shutil.rmtree(\'/sdcard/DCIM\')"'), true, 'python -c');
  assert.equal(mustApprove('node -e "require(\'fs\').rmSync(\'/x\',{recursive:true})"'), true, 'node -e');
  assert.equal(mustApprove('find /sdcard -type f -delete'), true, 'find -delete');
  assert.equal(mustApprove('echo pwned > /sdcard/Download/nota.txt'), true, 'redirección a /sdcard');
  assert.equal(mustApprove('truncate -s 0 /sdcard/x'), true, 'truncate');
  assert.equal(mustApprove('pm uninstall com.whatsapp'), true, 'pm uninstall');
  // Comandos legítimos de lectura siguen sin pedir aprobación.
  assert.equal(mustApprove('python3 script.py'), false, 'python script normal');
  assert.equal(mustApprove('node index.js'), false, 'node script normal');
  assert.equal(mustApprove('cat archivo.txt'), false, 'cat normal');
}

// ── Guards de tools: archivo protegido (M1) + SSRF (M1) ──────────────────────
{
  const execute = createLocalToolExecutor();
  const dir = path.join(os.tmpdir(), 'claw-guard-test');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'novaclaw.config.json'), '{"apiKey":"sk-secreta"}', 'utf8');

  const readKey = await execute(
    { tool: 'file.read', arguments: { path: path.join(dir, 'novaclaw.config.json') } },
    { cwd: dir, workspaceRoot: dir },
  );
  assert.equal(readKey.status, 'error', 'no debe leer el archivo con la key');
  assert.doesNotMatch(readKey.output, /sk-secreta/, 'la key nunca aparece en la salida');

  const ssrf = await execute(
    { tool: 'web.fetch', arguments: { url: 'http://127.0.0.1:8099/ping' } },
    { cwd: dir, workspaceRoot: dir },
  );
  assert.equal(ssrf.status, 'error', 'web.fetch a loopback bloqueado');
  assert.match(ssrf.output, /SSRF|Blocked/i);

  const ssrfLan = await execute(
    { tool: 'web.fetch', arguments: { url: 'http://10.0.0.5/admin' } },
    { cwd: dir, workspaceRoot: dir },
  );
  assert.equal(ssrfLan.status, 'error', 'web.fetch a red privada bloqueado');
}

console.log('agent-safety.test.mjs passed');
