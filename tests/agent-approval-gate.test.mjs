// Freno de emergencia: la ejecución de código NUNCA corre sola.
//
// La allowlist de safety.ts era evadible en dos pasos (file.write payload.js →
// terminal.run node payload.js), y mcp.add ni siquiera pasaba por la política:
// caía en el "todo lo demás es seguro" de classifyToolCall y hacía spawn de
// cualquier binario. Hasta que exista una allowlist estructurada sin shell, las
// dos puertas de ejecución piden aprobación SIEMPRE, y esa aprobación no la
// puede saltar ni el modo auto ni el "permitir siempre".
import assert from 'node:assert/strict';

const { classifyToolCall } = await import('../src/agent/safety.ts');

const workspaceRoot = '/workspace/project';
const context = { cwd: workspaceRoot, workspaceRoot };

const clasificar = (tool, args) => classifyToolCall({ tool, arguments: args }, context);

// ── terminal.run: toda ejecución pide aprobación ────────────────────────────

{
  // El bypass que motivó el parche: escribir un script y ejecutarlo.
  const node = clasificar('terminal.run', { command: 'node payload.js' });
  assert.equal(node.requiresApproval, true, 'node <script> debe pedir aprobación');

  const python = clasificar('terminal.run', { command: 'python payload.py' });
  assert.equal(python.requiresApproval, true, 'python <script> debe pedir aprobación');

  const npmRun = clasificar('terminal.run', { command: 'npm run build' });
  assert.equal(npmRun.requiresApproval, true, 'npm run ejecuta scripts del proyecto');
}

{
  // Incluso lo que la allowlist consideraba de solo lectura: mientras la
  // política sea "no sabemos distinguir", no distinguimos.
  const ls = clasificar('terminal.run', { command: 'ls -la' });
  assert.equal(ls.requiresApproval, true, 'ningún comando corre solo durante el freno');

  // Y las fugas concretas que encontramos, por si el freno se levanta algún día.
  for (const command of [
    'printenv ZEN_API_KEY',
    'env',
    'cat /proc/self/environ',
    'sort /etc/hosts -o /tmp/robado',
    'git reflog expire --expire=now --all',
  ]) {
    assert.equal(clasificar('terminal.run', { command }).requiresApproval, true, `${command} debe pedir aprobación`);
  }
}

{
  // El usuario tiene que ver QUÉ va a correr antes de decir que sí.
  const decision = clasificar('terminal.run', { command: 'node payload.js' });
  assert.match(decision.summary, /node payload\.js/, 'el comando exacto va en el resumen');
}

// ── mcp.add: spawn de un binario arbitrario ─────────────────────────────────

{
  // mcp.add hace spawn(command, args) directo. Era la segunda puerta abierta.
  const malicioso = clasificar('mcp.add', {
    name: 'x',
    command: 'node',
    args: ['payload con espacios.js', '--flag=value'],
  });
  assert.equal(malicioso.requiresApproval, true, 'mcp.add ejecuta un binario: pide aprobación');
  assert.match(malicioso.summary, /node/, 'el comando va en el resumen');
  assert.match(
    malicioso.summary,
    /argv=\["node","payload con espacios\.js","--flag=value"\]/,
    'command y args conservan límites inequívocos como JSON',
  );

  // Un MCP legítimo también: npx descarga y ejecuta código de npm.
  const legitimo = clasificar('mcp.add', {
    name: 'github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
  });
  assert.equal(legitimo.requiresApproval, true, 'npx -y también descarga y ejecuta código');
}

// ── La aprobación de ejecución no se puede saltar ───────────────────────────

{
  // Modo auto y "permitir siempre" consultan este campo: si está, mandan sobre
  // ambos. Sin él, /auto seguiría corriendo node payload.js sin preguntar.
  const shell = clasificar('terminal.run', { command: 'node payload.js' });
  assert.equal(shell.mandatory, true, 'terminal.run: aprobación no saltable por auto');

  const mcp = clasificar('mcp.add', { name: 'x', command: 'node', args: ['payload.js'] });
  assert.equal(mcp.mandatory, true, 'mcp.add: aprobación no saltable por auto');
}

// ── Lo que NO cambia: leer sigue siendo gratis ──────────────────────────────

{
  const read = clasificar('file.read', { path: `${workspaceRoot}/src/index.ts` });
  assert.equal(read.requiresApproval, false, 'leer dentro del workspace no pide aprobación');
  assert.notEqual(read.mandatory, true, 'leer no es una acción de ejecución');

  const write = clasificar('file.write', { path: `${workspaceRoot}/src/nuevo.ts`, content: 'x' });
  assert.equal(write.requiresApproval, false, 'escribir dentro del workspace sigue igual');
}

// ── Quién puede saltarse la aprobación y quién no ───────────────────────────
// AUTO sí: el usuario lo eligió a propósito. "Permitir siempre" no: es un clic
// dentro de un diálogo y no debe valer por un permiso permanente para ejecutar.

{
  const { createAgentRuntime, createAgentSession } = await import('../src/agent/runtime.ts');
  const os = await import('node:os');

  const construirRuntime = (onExec) => {
    const respuestas = [
      '{"kind":"tool_call","tool":"terminal.run","arguments":{"command":"node payload.js"}}',
      '{"kind":"message","message":"listo"}',
    ];
    return createAgentRuntime({
      workspaceRoot: os.tmpdir(),
      callModel: async () => respuestas.shift() ?? '{"kind":"message","message":"fin"}',
      executeToolCall: async (c) => {
        if (onExec) { onExec(c); return { name: c.tool, command: '', status: 'success', output: 'ok' }; }
        throw new Error('el executor NO debe correr sin aprobación');
      },
    });
  };

  // Modo auto: es una decisión deliberada del usuario ("trabajá solo"), y en ese
  // modo NO se pregunta nada. Es lo mismo que hace Claude Code al saltarse los
  // permisos: el consentimiento se da una vez, al elegir el modo, no por acción.
  const corridos = [];
  const enAuto = createAgentSession('auto', os.tmpdir());
  const auto = await construirRuntime((c) => corridos.push(c.tool))
    .runUserTurn(enAuto, 'corré el payload', undefined, undefined, 'auto');
  assert.ok(!auto.events.some((e) => e.type === 'approval'), '/auto no pregunta');
  assert.deepEqual(corridos, ['terminal.run'], '/auto ejecuta de verdad');

  // "Permitir siempre" es otra cosa: es un clic dentro de un diálogo, fácil de
  // dar sin leer. No habilita para siempre la ejecución de código; para eso está
  // auto, que se elige a propósito.
  const conSiempre = createAgentSession('siempre', os.tmpdir());
  conSiempre.autoApproveTools = ['terminal.run'];
  const siempre = await construirRuntime().runUserTurn(conSiempre, 'corré el payload');
  assert.equal(siempre.events[0].type, 'approval', '"permitir siempre" no cubre la ejecución');

  // Y en modo normal (build) se sigue preguntando todo.
  const enBuild = createAgentSession('build', os.tmpdir());
  const build = await construirRuntime().runUserTurn(enBuild, 'corré el payload');
  assert.equal(build.events[0].type, 'approval', 'en modo normal se pregunta');
}

// ── Tercera puerta: inyección por el NOMBRE del archivo ─────────────────────
//
// file.extract construía la línea con interpolación (`markitdown "${path}"`) y
// la corría con shell. Dentro de comillas dobles el shell expande $( ), así que
// un archivo llamado `informe$(comando).pdf` ejecutaba `comando` — y el agente
// puede crear ese archivo con file.write, que no pide aprobación. La expansión
// ocurre aunque markitdown no esté instalado: pasa antes de buscar el binario.

{
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createLocalToolExecutor } = await import('../src/agent/tools.ts');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novaclaw-iny-'));
  // El exec corre con cwd = dir, así que el touch cae ahí con nombre relativo.
  const marca = path.join(dir, 'INYECTADO');
  const trampa = path.join(dir, 'informe$(touch INYECTADO).pdf');
  await fs.writeFile(trampa, '%PDF-1.4 falso', 'utf8');

  const execute = createLocalToolExecutor();
  await execute(
    { tool: 'file.extract', arguments: { path: trampa } },
    { cwd: dir, workspaceRoot: dir },
  );

  let ejecutado = true;
  try { await fs.access(marca); } catch { ejecutado = false; }
  assert.equal(ejecutado, false, 'el nombre del archivo NO debe ejecutarse como comando');

  // Incluso sin shell, el proceso externo no debe arrancar dentro del workspace.
  // Un markitdown falso (el propio Node con otro nombre) registra su cwd al
  // procesar un .cjs controlado. Esto protege el aislamiento adicional al -I.
  const fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'novaclaw-bin-'));
  const fakeMarkitdown = path.join(fakeBinDir, process.platform === 'win32' ? 'markitdown.exe' : 'markitdown');
  if (process.platform === 'win32') {
    await fs.copyFile(process.execPath, fakeMarkitdown);
  } else {
    await fs.symlink(process.execPath, fakeMarkitdown);
  }
  const cwdRegistrado = path.join(dir, 'cwd.txt');
  const extractor = path.join(dir, 'registra-cwd.cjs');
  await fs.writeFile(
    extractor,
    `require('node:fs').writeFileSync(${JSON.stringify(cwdRegistrado)}, process.cwd());\n`,
    'utf8',
  );
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${fakeBinDir}${path.delimiter}${oldPath ?? ''}`;
    await execute(
      { tool: 'file.extract', arguments: { path: extractor } },
      { cwd: dir, workspaceRoot: dir },
    );
    assert.equal(
      await fs.readFile(cwdRegistrado, 'utf8'),
      path.dirname(process.execPath),
      'file.extract debe lanzar conversores desde el cwd confiable del runtime',
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await fs.rm(fakeBinDir, { recursive: true, force: true });
  }

  await fs.rm(dir, { recursive: true, force: true });
}

// ── La misma inyección, por code_intel/diagnostics ──────────────────────────
// runDiagnostics interpolaba la ruta en `node --check "${filePath}"` y compañía,
// y tampoco pide aprobación. Mismo exploit, otra puerta.

{
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { runDiagnostics } = await import('../src/agent/diagnostics.ts');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novaclaw-diag-'));
  const marca = path.join(dir, 'INYECTADO');
  const trampa = path.join(dir, 'script$(touch INYECTADO).js');
  await fs.writeFile(trampa, 'const x = 1;\n', 'utf8');

  await runDiagnostics(trampa, dir);

  let ejecutado = true;
  try { await fs.access(marca); } catch { ejecutado = false; }
  assert.equal(ejecutado, false, 'diagnostics no debe ejecutar el nombre del archivo');

  await fs.rm(dir, { recursive: true, force: true });
}

// ── Las tools que corren código DEL WORKSPACE también son ejecución ─────────
//
// Quitar el shell tapó la inyección por nombre de archivo, pero estas tres
// siguen ejecutando lo que haya en el proyecto: eslint corre su config (que es
// JS), `cargo check` compila build.rs, code.intel arranca el language server de
// node_modules, y `python3 -m markitdown` toma el módulo del cwd si está ahí.
// Como el agente puede escribir esos archivos sin aprobación, es la misma cadena
// de dos pasos que cerramos en terminal.run.

{
  for (const tool of ['diagnostics.check', 'code.intel', 'file.extract']) {
    const d = clasificar(tool, { path: '/w/a.ts' });
    assert.equal(d.requiresApproval, true, `${tool} ejecuta código del proyecto: pide aprobación`);
    assert.equal(d.mandatory, true, `${tool}: no saltable por auto`);
  }
}

{
  // …y el fast-path de solo-lectura no puede esquivarlo. Cuando dos tools de
  // READ_ONLY_TOOLS venían seguidas, el runtime las corría con executeOnly, que
  // NO consulta la política. Marcarlas mandatory sin cerrar esto no serviría.
  const { READ_ONLY_TOOLS } = await import('../src/agent/nativeAgentSupport.ts');
  for (const nombre of ['file_extract', 'code_intel']) {
    assert.equal(READ_ONLY_TOOLS.has(nombre), false, `${nombre} no puede estar en el fast-path`);
  }
}

{
  // Plan es "solo mirar": no puede instalar ni quitar servidores MCP.
  const { isPlanBlocked } = await import('../src/agent/nativeAgentSupport.ts');
  assert.equal(isPlanBlocked('mcp_add'), true, 'Plan no instala MCPs');
  assert.equal(isPlanBlocked('mcp_remove'), true, 'Plan no quita MCPs');
  assert.equal(isPlanBlocked('file.write'), true, 'el runtime legacy usa nombres con punto');
  assert.equal(isPlanBlocked('diagnostics_check'), true, 'Plan no ejecuta diagnósticos del proyecto');
}

{
  // Escribir configuración EJECUTABLE es ejecución diferida: quien controla
  // eslint.config.js o novaclaw.hooks.json controla lo que corre después.
  for (const p of ['/w/novaclaw.hooks.json', '/w/eslint.config.js', '/w/novaclaw.mcp.json']) {
    const d = clasificar('file.write', { path: p, content: 'x' });
    assert.equal(d.requiresApproval, true, `${p} pide aprobación`);
    assert.equal(d.mandatory, true, `${p}: /auto tampoco puede escribirlo solo`);
  }
}

// ── El runtime NATIVO (el del teléfono) respeta lo mismo ────────────────────
// Arriba se probó createAgentRuntime (el legacy, sin API key). El que corre en
// producción es el nativo, con function-calling: tiene su propio call site.

{
  const { createNativeAgentRuntime } = await import('../src/agent/nativeAgent.ts');
  const { createAgentSession } = await import('../src/agent/runtime.ts');
  const os = await import('node:os');

  const construir = (llamadas, onExec) => createNativeAgentRuntime({
    workspaceRoot: os.tmpdir(),
    getConfig: () => ({ providerId: 'x', apiKey: 'x', model: 'm' }),
    callModel: async () => (llamadas.shift() ?? { text: 'listo' }),
    executeToolCall: async (c) => {
      if (onExec) { onExec(c); return { name: c.tool, command: '', status: 'success', output: 'ok' }; }
      throw new Error('el executor NO debe correr sin aprobación');
    },
  });

  // AUTO no pregunta nada: el usuario ya dio el permiso al elegir el modo, igual
  // que al saltarse los permisos en Claude Code. El executor corre.
  const corridos = [];
  const s1 = createAgentSession('nativo-auto', os.tmpdir());
  const r1 = await construir(
    [{ toolCalls: [{ id: 'a', name: 'terminal_run', args: { command: 'node payload.js' } }] }],
    (c) => corridos.push(c.tool),
  ).runUserTurn(s1, 'corré', undefined, undefined, 'auto');
  assert.ok(!r1.events.some((e) => e.type === 'approval'), 'nativo: /auto no pregunta');
  assert.deepEqual(corridos, ['terminal.run'], 'nativo: /auto ejecuta de verdad');

  // En modo normal (build) sí para: mcp_add arranca un proceso.
  const s2 = createAgentSession('nativo-build', os.tmpdir());
  const r2 = await construir([{ toolCalls: [{ id: 'b', name: 'mcp_add', args: { name: 'x', command: 'node', args: ['payload.js'] } }] }])
    .runUserTurn(s2, 'instalá');
  assert.ok(r2.events.some((e) => e.type === 'approval'), 'nativo: en build, mcp_add pregunta');

  // Dos tools del viejo fast-path seguidas: antes se ejecutaban en paralelo sin
  // consultar la política. Ahora file_extract exige aprobación.
  const s3 = createAgentSession('nativo-fastpath', os.tmpdir());
  const r3 = await construir([{ toolCalls: [
    { id: 'c', name: 'file_extract', args: { path: 'a.pdf' } },
    { id: 'd', name: 'file_extract', args: { path: 'b.pdf' } },
  ] }]).runUserTurn(s3, 'leé los dos');
  assert.ok(r3.events.some((e) => e.type === 'approval'), 'nativo: el fast-path no esquiva la aprobación');

  // El runtime nativo también es singleton: intercalar Auto mientras Plan espera
  // al modelo no puede cambiar el modo del primer turno.
  let releasePlan;
  let signalPlanEntered;
  const planEntered = new Promise((resolve) => { signalPlanEntered = resolve; });
  const planGate = new Promise((resolve) => { releasePlan = resolve; });
  let modelCalls = 0;
  const executed = [];
  const concurrent = createNativeAgentRuntime({
    workspaceRoot: os.tmpdir(),
    getConfig: () => ({ providerId: 'x', apiKey: 'x', model: 'm' }),
    callModel: async () => {
      modelCalls += 1;
      if (modelCalls === 1) {
        signalPlanEntered();
        await planGate;
        return { toolCalls: [{ id: 'race', name: 'file_write', args: { path: 'race.txt', content: 'no' } }] };
      }
      if (modelCalls === 2) return { text: 'auto terminó' };
      return { text: 'plan terminó' };
    },
    executeToolCall: async (call) => {
      executed.push(call.tool);
      return { name: call.tool, command: '', status: 'success', output: 'ejecutado', cwd: os.tmpdir() };
    },
  });
  const planSession = createAgentSession('native-plan-race', os.tmpdir());
  const autoSession = createAgentSession('native-auto-race', os.tmpdir());
  const planPromise = concurrent.runUserTurn(planSession, 'planificá', undefined, undefined, 'plan');
  await planEntered;
  await concurrent.runUserTurn(autoSession, 'hacé', undefined, undefined, 'auto');
  releasePlan();
  const planResult = await planPromise;
  assert.deepEqual(executed, [], 'nativo: Auto concurrente no altera Plan');
  assert.match(planResult.events[0].toolExecution.output, /PLAN MODE/);
}

console.log('agent-approval-gate.test.mjs passed');
