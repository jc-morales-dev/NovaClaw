// La API key del usuario y el token app↔agente viajan en process.env del agente
// (RuntimeManager los inyecta al arrancar en Android). Todo proceso hijo que
// herede ese entorno puede leerlos: `printenv ZEN_API_KEY`, `cat /proc/self/environ`,
// o un `node -e` cualquiera.
//
// El gate de aprobación ya no deja correr shell sin permiso, pero eso solo mueve
// el problema: basta UN comando aprobado para llevarse la key. La defensa que
// falta es no ponerla nunca en el entorno del hijo.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { createLocalToolExecutor } = await import('../src/agent/tools.ts');
const { sanitizeChildEnv } = await import('../src/agent/childEnv.ts');

const CLAVE = 'zen-key-de-prueba-NO-DEBE-FILTRARSE';
const TOKEN = 'token-de-prueba-NO-DEBE-FILTRARSE';

test('terminal.run no puede leer la API key del entorno', async () => {
  const previa = process.env.ZEN_API_KEY;
  process.env.ZEN_API_KEY = CLAVE;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novaclaw-env-'));

  try {
    const execute = createLocalToolExecutor();
    const r = await execute(
      {
        tool: 'terminal.run',
        arguments: { command: `node -e "console.log(process.env.ZEN_API_KEY || 'SIN-CLAVE')"` },
      },
      { cwd: dir, workspaceRoot: dir },
    );

    assert.doesNotMatch(
      r.output,
      new RegExp(CLAVE),
      `un comando de shell no debe ver la API key (salida: ${r.output})`,
    );
  } finally {
    if (previa === undefined) delete process.env.ZEN_API_KEY;
    else process.env.ZEN_API_KEY = previa;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('terminal.run no puede leer el token app↔agente', async () => {
  const previa = process.env.NOVACLAW_TOKEN;
  process.env.NOVACLAW_TOKEN = TOKEN;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novaclaw-env-'));

  try {
    const execute = createLocalToolExecutor();
    const r = await execute(
      {
        tool: 'terminal.run',
        arguments: { command: `node -e "console.log(process.env.NOVACLAW_TOKEN || 'SIN-TOKEN')"` },
      },
      { cwd: dir, workspaceRoot: dir },
    );

    // Con el token, otra app del teléfono le habla al agente por loopback: es
    // tan sensible como la key.
    assert.doesNotMatch(
      r.output,
      new RegExp(TOKEN),
      `un comando de shell no debe ver el token del agente (salida: ${r.output})`,
    );
  } finally {
    if (previa === undefined) delete process.env.NOVACLAW_TOKEN;
    else process.env.NOVACLAW_TOKEN = previa;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('sanitizeChildEnv quita secretos y conserva lo que el shell necesita', () => {
  const limpio = sanitizeChildEnv({
    PATH: '/usr/bin',
    HOME: '/home/nova',
    SHELL: '/bin/sh',
    TERM: 'xterm',
    LANG: 'es_ES.UTF-8',
    ZEN_API_KEY: CLAVE,
    NOVACLAW_TOKEN: TOKEN,
  });

  assert.equal(limpio.PATH, '/usr/bin');
  assert.equal(limpio.HOME, '/home/nova');
  assert.equal(limpio.SHELL, '/bin/sh');
  assert.equal(limpio.TERM, 'xterm');
  assert.equal(limpio.LANG, 'es_ES.UTF-8');
  assert.equal(limpio.ZEN_API_KEY, undefined);
  assert.equal(limpio.NOVACLAW_TOKEN, undefined);
});

test('sanitizeChildEnv quita credenciales de terceros por su forma', () => {
  const limpio = sanitizeChildEnv({
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-ant-xxx',
    OPENAI_API_KEY: 'sk-xxx',
    OPENROUTER_API_KEY: 'sk-or-xxx',
    GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_xxx',
    AWS_SECRET_ACCESS_KEY: 'xxx',
    DB_PASSWORD: 'xxx',
    POSTGRES_CONNECTION_STRING: 'postgres://user:pass@host/db',
  });

  assert.equal(limpio.PATH, '/usr/bin');
  for (const nombre of [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
    'GITHUB_PERSONAL_ACCESS_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD',
    'POSTGRES_CONNECTION_STRING',
  ]) {
    assert.equal(limpio[nombre], undefined, `${nombre} no debe llegar al hijo`);
  }
});

test('un hook PostToolUse no puede leer la API key', async () => {
  const { runPostToolUseHooks } = await import('../src/server/hooks.ts');
  const previa = process.env.ZEN_API_KEY;
  process.env.ZEN_API_KEY = CLAVE;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novaclaw-hook-'));

  try {
    // Un repo clonado puede traer su propio novaclaw.hooks.json: el hook es
    // código de un tercero corriendo en el teléfono del usuario.
    await fs.writeFile(
      path.join(dir, 'novaclaw.hooks.json'),
      JSON.stringify({
        PostToolUse: [{
          matcher: 'file.write',
          command: `node -e "console.log(process.env.ZEN_API_KEY || 'SIN-CLAVE')"`,
        }],
      }),
      'utf8',
    );

    const resumen = await runPostToolUseHooks('file.write', path.join(dir, 'x.txt'), dir);
    assert.doesNotMatch(
      String(resumen ?? ''),
      new RegExp(CLAVE),
      `un hook no debe ver la API key (salida: ${resumen})`,
    );
  } finally {
    if (previa === undefined) delete process.env.ZEN_API_KEY;
    else process.env.ZEN_API_KEY = previa;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ningún lanzador de procesos hereda process.env sin sanear', async () => {
  // Red de seguridad estructural: da igual cuántos puntos de ejecución se
  // agreguen después, ninguno debe volver a pasar el entorno crudo. Se mira el
  // código fuente porque el PTY y los servidores MCP no se pueden lanzar en un
  // test sin montar la app entera.
  const srcDir = path.resolve('src');

  const archivos = [];
  const recorrer = async (dir) => {
    for (const entrada of await fs.readdir(dir, { withFileTypes: true })) {
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) await recorrer(completo);
      else if (entrada.name.endsWith('.ts') || entrada.name.endsWith('.tsx')) archivos.push(completo);
    }
  };
  await recorrer(srcDir);

  const infractores = [];
  for (const archivo of archivos) {
    if (archivo.endsWith(`${path.sep}childEnv.ts`)) continue;
    const texto = await fs.readFile(archivo, 'utf8');
    texto.split('\n').forEach((linea, i) => {
      // `env: process.env` o `env: { ...process.env, … }` al construir un hijo.
      if (/env:\s*(\{\s*\.\.\.)?process\.env/.test(linea)) {
        infractores.push(`${path.relative(srcDir, archivo)}:${i + 1}: ${linea.trim()}`);
      }
    });
  }

  assert.deepEqual(
    infractores,
    [],
    `estos lanzamientos pasan el entorno con secretos; usá sanitizeChildEnv:\n${infractores.join('\n')}`,
  );
});

test('sanitizeChildEnv deja pasar los extras que el llamador pide a propósito', () => {
  // mcp.add sí necesita entregarle su credencial al servidor MCP concreto que el
  // usuario configuró: el filtro es para lo heredado, no para lo explícito.
  const limpio = sanitizeChildEnv(
    { PATH: '/usr/bin', ZEN_API_KEY: CLAVE },
    { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_del_usuario' },
  );

  assert.equal(limpio.GITHUB_PERSONAL_ACCESS_TOKEN, 'ghp_del_usuario');
  assert.equal(limpio.ZEN_API_KEY, undefined);
});
