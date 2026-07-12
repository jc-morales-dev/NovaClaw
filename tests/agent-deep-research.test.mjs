import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  performDeepResearch,
  buildResearchDigest,
} = await import('../src/agent/deepResearch.ts');
const { createLocalToolExecutor } = await import('../src/agent/tools.ts');
const { TOOL_SCHEMAS, TOOL_NAME_TO_DOT } = await import('../src/agent/toolSchemas.ts');
const { READ_ONLY_TOOLS } = await import('../src/agent/nativeAgentSupport.ts');

test('performDeepResearch encadena búsqueda + fetch (con mocks, sin red)', async () => {
  const search = async (q, max) => {
    assert.equal(q, 'mejor lenguaje 2026');
    assert.ok(max >= 4);
    return [
      { title: 'Fuente A', url: 'https://a.com', snippet: 'sa' },
      { title: 'Fuente B', url: 'https://b.com', snippet: 'sb' },
      { title: 'Fuente C', url: 'https://c.com', snippet: 'sc' },
    ];
  };
  const fetchPage = async (url) => {
    if (url === 'https://b.com') return { ok: false, text: 'timeout' };
    return { ok: true, text: `contenido de ${url}` };
  };

  const { query, sources } = await performDeepResearch('mejor lenguaje 2026', {
    maxSources: 3, search, fetchPage,
  });
  assert.equal(query, 'mejor lenguaje 2026');
  assert.equal(sources.length, 3);
  assert.equal(sources[0].content, 'contenido de https://a.com');
  assert.equal(sources[1].content, '');           // b falló
  assert.equal(sources[1].error, 'timeout');
});

test('performDeepResearch respeta maxSources', async () => {
  const search = async () => Array.from({ length: 10 }, (_, i) => ({
    title: `T${i}`, url: `https://x${i}.com`, snippet: '',
  }));
  const fetchPage = async () => ({ ok: true, text: 'x' });
  const { sources } = await performDeepResearch('q', { maxSources: 2, search, fetchPage });
  assert.equal(sources.length, 2);
});

test('performDeepResearch con query vacía no toca la red', async () => {
  let searched = false;
  const search = async () => { searched = true; return []; };
  const { sources } = await performDeepResearch('   ', { search, fetchPage: async () => ({ ok: true, text: '' }) });
  assert.equal(searched, false);
  assert.deepEqual(sources, []);
});

test('buildResearchDigest numera fuentes y pide citar + contrastar', () => {
  const digest = buildResearchDigest('tema', [
    { title: 'A', url: 'https://a.com', snippet: 'sa', content: 'texto A', error: '' },
    { title: 'B', url: 'https://b.com', snippet: 'sb', content: '', error: 'timeout' },
  ]);
  assert.match(digest, /\[1\] A/);
  assert.match(digest, /\[2\] B/);
  assert.match(digest, /https:\/\/a\.com/);
  assert.match(digest, /texto A/);
  assert.match(digest, /CROSS-CHECK/i);
  // La fuente ilegible cae al snippet.
  assert.match(digest, /could not read/i);
  assert.match(digest, /sb/);
});

test('buildResearchDigest maneja el caso sin fuentes', () => {
  assert.match(buildResearchDigest('nada', []), /No sources found/);
});

test('executor deep.research con query vacía → error (sin red)', async () => {
  const executor = createLocalToolExecutor();
  const res = await executor(
    { tool: 'deep.research', arguments: { query: '' } },
    { cwd: process.cwd(), workspaceRoot: process.cwd() },
  );
  assert.equal(res.status, 'error');
  assert.match(res.output, /research question/i);
});

test('deep_research registrado: schema + mapeo + read-only', () => {
  const schema = TOOL_SCHEMAS.find((t) => t.name === 'deep_research');
  assert.ok(schema, 'falta el schema deep_research');
  assert.ok(schema.parameters.required.includes('query'));
  assert.equal(TOOL_NAME_TO_DOT.deep_research, 'deep.research');
  assert.ok(READ_ONLY_TOOLS.has('deep_research'), 'deep_research debe ser read-only (paralelo)');
});

console.log('agent-deep-research.test.mjs passed');
