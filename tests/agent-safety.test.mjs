import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { classifyToolCall, analyzeShellCommand } = await import('../src/agent/safety.ts');
const { createLocalToolExecutor } = await import('../src/agent/tools.ts');

const workspaceRoot = '/workspace/project';

// Desde el freno de emergencia, hasta `ls` pide aprobación: un shell heredado
// puede leer secretos del entorno y ejecutar archivos ya escritos, así que no
// distinguimos por comando. El análisis sobrevive para explicar el riesgo en el
// diálogo. Detalle fino del gate en agent-approval-gate.test.mjs.
const safeShell = classifyToolCall(
  {
    tool: 'terminal.run',
    arguments: { command: 'ls -la', cwd: workspaceRoot },
  },
  { cwd: workspaceRoot, workspaceRoot },
);
assert.equal(safeShell.requiresApproval, true);
assert.equal(safeShell.mandatory, true);
assert.doesNotMatch(safeShell.reason, /sensitive/i, 'un comando de lectura no se anuncia como peligroso');

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
//
// OJO con lo que prueba este bloque y los siguientes: desde el freno de
// emergencia, classifyToolCall devuelve `true` para CUALQUIER terminal.run, así
// que preguntarle a él por estos comandos pasaría aunque el analizador estuviera
// roto. Los casos de abajo van contra analyzeShellCommand, que es quien de
// verdad clasifica y quien volverá a decidir cuando se reconstruya la allowlist
// estructurada. La política vive en agent-approval-gate.test.mjs.
{
  const inseguro = (command) => !analyzeShellCommand(command).safe;

  assert.equal(inseguro('python3 -c "import shutil; shutil.rmtree(\'/sdcard/DCIM\')"'), true, 'python -c');
  assert.equal(inseguro('node -e "require(\'fs\').rmSync(\'/x\',{recursive:true})"'), true, 'node -e');
  assert.equal(inseguro('find /sdcard -type f -delete'), true, 'find -delete');
  assert.equal(inseguro('echo pwned > /sdcard/Download/nota.txt'), true, 'redirección a /sdcard');
  assert.equal(inseguro('truncate -s 0 /sdcard/x'), true, 'truncate');
  assert.equal(inseguro('pm uninstall com.whatsapp'), true, 'pm uninstall');
  assert.equal(inseguro('cat archivo.txt'), false, 'cat normal');

  // Estos DOS eran el agujero: el analizador los sigue viendo "seguros" porque
  // no puede saber qué hay dentro del script. Escribir el archivo tampoco pedía
  // aprobación, así que file.write + terminal.run daba ejecución arbitraria. Por
  // eso el freno es global y no una excepción más en la lista.
  assert.equal(inseguro('python3 script.py'), false, 'el analizador no ve dentro del script');
  assert.equal(inseguro('node index.js'), false, 'el analizador no ve dentro del script');
  const gate = (command) =>
    classifyToolCall({ tool: 'terminal.run', arguments: { command } }, { cwd: workspaceRoot, workspaceRoot });
  assert.equal(gate('python3 script.py').requiresApproval, true, 'pero la política los frena');
  assert.equal(gate('node index.js').requiresApproval, true, 'pero la política los frena');
}

// ── Modelo ALLOWLIST (default-deny): bypasses que la blacklist dejaba pasar ──
{
  // Contra el analizador, no contra la política: ver la nota del bloque anterior.
  const mustApprove = (command) => !analyzeShellCommand(command).safe;

  // Bypasses clásicos de blacklist: binarios no listados → SIEMPRE aprobación.
  assert.equal(mustApprove('busybox rm -rf /sdcard/DCIM'), true, 'busybox rm');
  assert.equal(mustApprove('cp /dev/null importante.txt'), true, 'cp /dev/null');
  assert.equal(mustApprove('install -m 755 evil /usr/bin/ls'), true, 'install');
  assert.equal(mustApprove('ln -sf /sdcard enlace'), true, 'ln');
  assert.equal(mustApprove('tar --overwrite -xf x.tar'), true, 'tar overwrite');
  assert.equal(mustApprove('npx cowsay hola'), true, 'npx ejecuta paquetes remotos');
  assert.equal(mustApprove('toybox rm -rf x'), true, 'toybox');

  // Encadenados: si CUALQUIER segmento no es seguro, todo pide aprobación.
  assert.equal(mustApprove('ls && rm -rf tmp'), true, 'segundo segmento inseguro (&&)');
  assert.equal(mustApprove('cat x.txt; busybox rm y'), true, 'segundo segmento inseguro (;)');
  assert.equal(mustApprove('cat script.sh | sh'), true, 'pipe a shell');
  assert.equal(mustApprove('echo hola | tee /sdcard/x'), true, 'pipe a tee');

  // Sustitución de comandos y variables de entorno peligrosas.
  assert.equal(mustApprove('echo $(rm -rf x)'), true, 'sustitución $( )');
  assert.equal(mustApprove('echo `rm -rf x`'), true, 'backticks');
  assert.equal(mustApprove('LD_PRELOAD=/data/evil.so ls'), true, 'LD_PRELOAD');
  assert.equal(mustApprove('PATH=/tmp/evil:$PATH cat x'), true, 'PATH override');

  // Redirecciones de escritura (salvo /dev/null) piden aprobación…
  assert.equal(mustApprove('echo data > salida.txt'), true, 'redirección a archivo');
  assert.equal(mustApprove('ls >> log.txt'), true, 'append a archivo');
  // …pero las inofensivas de silenciar output no.
  assert.equal(mustApprove('ls 2>/dev/null'), false, '2>/dev/null es inofensivo');
  assert.equal(mustApprove('node index.js 2>&1'), false, '2>&1 es inofensivo');

  // git: lectura libre, mutación con aprobación.
  assert.equal(mustApprove('git status'), false, 'git status');
  assert.equal(mustApprove('git log --oneline -5'), false, 'git log');
  assert.equal(mustApprove('git diff HEAD~1'), false, 'git diff');
  assert.equal(mustApprove('git push origin main'), true, 'git push');
  assert.equal(mustApprove('git checkout -- .'), true, 'git checkout');
  assert.equal(mustApprove('git clean -fd'), true, 'git clean');

  // Env vars normales no bloquean lo legítimo.
  assert.equal(mustApprove('NODE_ENV=test npm test'), false, 'NODE_ENV=test npm test');
  assert.equal(mustApprove('npm run build'), false, 'npm run script del workspace');

  // Rutas absolutas a binarios → no verificable → aprobación.
  assert.equal(mustApprove('/data/local/tmp/evil'), true, 'binario con ruta absoluta');
  assert.equal(mustApprove('./script-desconocido.sh'), true, 'binario con ruta relativa');

  // Pipelines de lectura legítimos siguen libres.
  assert.equal(mustApprove('cat server.ts | grep import | wc -l'), false, 'pipeline de lectura');
  assert.equal(mustApprove('grep -rn "TODO" src'), false, 'grep recursivo');
  assert.equal(mustApprove('find . -name "*.ts" -type f'), false, 'find de lectura');
  assert.equal(mustApprove('pm list packages'), false, 'pm list (lectura)');
  assert.equal(mustApprove('settings get global adb_enabled'), false, 'settings get (lectura)');
  assert.equal(mustApprove('settings put global adb_enabled 0'), true, 'settings put (mutación)');
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
