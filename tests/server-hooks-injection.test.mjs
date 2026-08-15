// Un hook es una línea de shell que el USUARIO escribe ("prettier --write $FILE").
// El shell es parte del diseño y no se puede quitar. Lo que sí se quita es la
// interpolación: si $FILE se sustituye como TEXTO dentro del comando, un archivo
// llamado `x$(comando).js` inyecta al guardar. Pasando la ruta por el ENTORNO,
// el shell expande $FILE como variable — y el contenido de una variable no se
// re-evalúa para sustitución de comandos.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { runPostToolUseHooks, substituteHookCommand } = await import('../src/server/hooks.ts');
const { sharedExecutor } = await import('../src/server/agentRuntimes.ts');

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novaclaw-hooks-'));

// Hook legítimo que escribe la ruta recibida. Se usa node y no `echo "$FILE"`
// porque el test corre también en Windows, donde exec usa cmd.exe y la sintaxis
// de variables es otra; leyendo process.env se comprueba lo mismo en ambos.
await fs.writeFile(
  path.join(dir, 'novaclaw.hooks.json'),
  JSON.stringify({
    PostToolUse: [{
      matcher: 'file.write',
      command: 'node -e "require(\'fs\').writeFileSync(\'recibido.txt\', process.argv[1] || \'\')" "$FILE"',
    }],
  }),
  'utf8',
);

// La trampa viaja en el NOMBRE del archivo editado.
const marca = path.join(dir, 'INYECTADO');
const trampa = path.join(dir, 'nota$(touch INYECTADO).js');
await fs.writeFile(trampa, '// x\n', 'utf8');

await runPostToolUseHooks('file.write', trampa, dir);

// Nota: este assert solo es significativo en POSIX (el teléfono). En Windows
// exec usa cmd.exe, donde `$(...)` no significa nada y pasaría igual.
let ejecutado = true;
try { await fs.access(marca); } catch { ejecutado = false; }
assert.equal(ejecutado, false, 'el nombre del archivo NO debe ejecutarse por el hook');

// Y el hook tiene que seguir SIRVIENDO: debe haber recibido la ruta de verdad.
const recibido = await fs.readFile(path.join(dir, 'recibido.txt'), 'utf8').catch(() => '');
assert.match(recibido, /nota\$\(touch INYECTADO\)\.js/, 'el hook recibe la ruta literal, sin ejecutarla');

// substituteHookCommand ya no debe meter la ruta en el texto del comando.
const cmd = substituteHookCommand('prettier --write $FILE', '/tmp/a$(x).js', '/tmp');
assert.doesNotMatch(cmd, /\$\(x\)/, 'la ruta no se interpola en el comando');

await fs.rm(dir, { recursive: true, force: true });

// Hotfix: una config que YA venía en un repo no fue aprobada al escribirse. El
// executor de producción no puede dispararla automáticamente tras una mutación.
const untrustedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'novaclaw-hooks-untrusted-'));
const autoMarker = path.join(untrustedDir, 'AUTO_EJECUTADO');
await fs.writeFile(
  path.join(untrustedDir, 'novaclaw.hooks.json'),
  JSON.stringify({
    PostToolUse: [{
      matcher: 'file.write',
      command: `node -e "require('fs').writeFileSync(${JSON.stringify(autoMarker)}, 'x')"`,
    }],
  }),
  'utf8',
);
await sharedExecutor(
  { tool: 'file.write', arguments: { path: 'normal.txt', content: 'ok' } },
  { cwd: untrustedDir, workspaceRoot: untrustedDir },
);
assert.equal(await fs.readFile(path.join(untrustedDir, 'normal.txt'), 'utf8'), 'ok');
const autoRan = await fs.access(autoMarker).then(() => true, () => false);
assert.equal(autoRan, false, 'el servidor no ejecuta hooks preexistentes sin un flujo de confianza');
await fs.rm(untrustedDir, { recursive: true, force: true });

console.log('server-hooks-injection.test.mjs passed');
