import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { buildSkillsIndex } = await import('../src/server/skills.ts');
const { hookMatches, substituteHookCommand, selectPostToolUseHooks, readHooksConfig, runPostToolUseHooks } =
  await import('../src/server/hooks.ts');
const { createLocalToolExecutor } = await import('../src/agent/tools.ts');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── B6: buildSkillsIndex arma el índice desde skills/<nombre>/SKILL.md ────────
test('buildSkillsIndex lee descripción de frontmatter y de la 1ª línea', () => {
  const root = tmpDir('nova-skills-');
  fs.mkdirSync(path.join(root, 'skills', 'foo'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'bar'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'sin-md'), { recursive: true }); // sin SKILL.md → se excluye
  fs.writeFileSync(path.join(root, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\ndescription: Hace foo muy bien\n---\n# Foo\n');
  fs.writeFileSync(path.join(root, 'skills', 'bar', 'SKILL.md'), '# Bar skill\nEsto hace bar.\n');

  const index = buildSkillsIndex(root);
  assert.match(index, /Available skills/);
  assert.match(index, /\*\*foo\*\* — Hace foo muy bien/);
  assert.match(index, /\*\*bar\*\* — Bar skill/);
  assert.doesNotMatch(index, /sin-md/, 'una carpeta sin SKILL.md no debe aparecer');
});

test('buildSkillsIndex devuelve vacío si no hay skills/', () => {
  const root = tmpDir('nova-noskills-');
  assert.equal(buildSkillsIndex(root), '');
});

// ── B7: helpers puros de hooks ───────────────────────────────────────────────
test('hookMatches: matcher regex sobre el nombre de tool', () => {
  assert.equal(hookMatches('file.edit|file.write', 'file.edit'), true);
  assert.equal(hookMatches('file.edit|file.write', 'file.grep'), false);
  assert.equal(hookMatches(undefined, 'cualquiera'), true, 'sin matcher aplica a todos');
});

test('substituteHookCommand: reemplaza $FILE / $FILE_PATH / $CWD', () => {
  const out = substituteHookCommand('fmt $FILE en $CWD', '/w/x.ts', '/w');
  assert.equal(out, 'fmt /w/x.ts en /w');
});

test('selectPostToolUseHooks filtra por matcher y descarta comandos vacíos', () => {
  const cfg = { PostToolUse: [
    { matcher: 'file.edit', command: 'a' },
    { matcher: 'file.grep', command: 'b' },
    { matcher: 'file.edit', command: '' }, // vacío → descartado
  ] };
  const sel = selectPostToolUseHooks(cfg, 'file.edit');
  assert.equal(sel.length, 1);
  assert.equal(sel[0].command, 'a');
});

test('readHooksConfig: archivo faltante o roto → {}', () => {
  const root = tmpDir('nova-hooks-');
  assert.deepEqual(readHooksConfig(root), {});
  fs.writeFileSync(path.join(root, 'novaclaw.hooks.json'), '{ roto');
  assert.deepEqual(readHooksConfig(root), {});
});

// ── B7: runPostToolUseHooks corre el comando y devuelve su salida ─────────────
test('runPostToolUseHooks ejecuta el hook que matchea y captura la salida', async () => {
  const root = tmpDir('nova-hookrun-');
  const cfg = { PostToolUse: [{ matcher: 'file.edit', command: `node -e "console.log('ok-hook')"`, description: 'test' }] };
  fs.writeFileSync(path.join(root, 'novaclaw.hooks.json'), JSON.stringify(cfg));

  const note = await runPostToolUseHooks('file.edit', path.join(root, 'x.ts'), root);
  assert.ok(note && /ok-hook/.test(note), `debe capturar la salida del hook: ${note}`);

  const none = await runPostToolUseHooks('file.grep', path.join(root, 'x.ts'), root);
  assert.equal(none, null, 'un tool que no matchea no dispara hooks');
});

// ── B7: el executor anexa la salida del hook tras una mutación exitosa ────────
test('createLocalToolExecutor con onAfterMutation anexa la nota al resultado', async () => {
  const root = tmpDir('nova-exechook-');
  const executor = createLocalToolExecutor({
    onAfterMutation: async ({ tool }) => `[hooks]\nhook ✓ ${tool}`,
  });
  const res = await executor(
    { tool: 'file.write', arguments: { path: path.join(root, 'a.ts'), content: 'x' } },
    { cwd: root, workspaceRoot: root },
  );
  assert.equal(res.status, 'success', res.output);
  assert.match(res.output, /\[hooks\]\nhook ✓ file\.write/, 'la nota del hook debe anexarse');
});

test('onAfterMutation NO corre para tools de solo lectura', async () => {
  const root = tmpDir('nova-exechook2-');
  fs.writeFileSync(path.join(root, 'r.txt'), 'hola');
  let called = false;
  const executor = createLocalToolExecutor({
    onAfterMutation: async () => { called = true; return 'x'; },
  });
  await executor({ tool: 'file.read', arguments: { path: path.join(root, 'r.txt') } }, { cwd: root, workspaceRoot: root });
  assert.equal(called, false, 'file.read no es mutación → no dispara hooks');
});
