import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  parseDuckDuckGoHtml,
  decodeDuckDuckGoHref,
  formatSearchResults,
  performWebSearch,
} = await import('../src/agent/webSearch.ts');
const { createLocalToolExecutor } = await import('../src/agent/tools.ts');
const { TOOL_SCHEMAS, TOOL_NAME_TO_DOT } = await import('../src/agent/toolSchemas.ts');

// HTML de resultados con la misma forma que devuelve html.duckduckgo.com.
const SAMPLE_HTML = `
<div class="result results_links web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffoo%3Fa%3D1&amp;rut=xyz">Example <b>Foo</b> Page</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffoo">This is the <b>first</b> snippet &amp; more.</a>
</div>
<div class="result results_links web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2F&amp;rut=abc">Python Docs</a>
  </h2>
  <a class="result__snippet" href="#">Official <b>Python</b> documentation.</a>
</div>
`;

test('parseDuckDuckGoHtml extrae título, url real y snippet', () => {
  const results = parseDuckDuckGoHtml(SAMPLE_HTML, 10);
  assert.equal(results.length, 2);

  assert.equal(results[0].title, 'Example Foo Page');
  assert.equal(results[0].url, 'https://example.com/foo?a=1');
  assert.equal(results[0].snippet, 'This is the first snippet & more.');

  assert.equal(results[1].title, 'Python Docs');
  assert.equal(results[1].url, 'https://docs.python.org/3/');
});

test('parseDuckDuckGoHtml respeta maxResults', () => {
  const results = parseDuckDuckGoHtml(SAMPLE_HTML, 1);
  assert.equal(results.length, 1);
});

test('parseDuckDuckGoHtml devuelve [] sin resultados', () => {
  assert.deepEqual(parseDuckDuckGoHtml('<html><body>nada</body></html>', 8), []);
});

test('decodeDuckDuckGoHref decodifica el redirect uddg', () => {
  const href = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fnode.org%2Fapi%3Fx%3D1&rut=aaa';
  assert.equal(decodeDuckDuckGoHref(href), 'https://node.org/api?x=1');
});

test('decodeDuckDuckGoHref normaliza //host a https://host', () => {
  assert.equal(decodeDuckDuckGoHref('//example.com/x'), 'https://example.com/x');
});

test('formatSearchResults numera y explica el próximo paso', () => {
  const out = formatSearchResults('python', [
    { title: 'Python', url: 'https://python.org', snippet: 'lang' },
  ]);
  assert.match(out, /1\. Python/);
  assert.match(out, /https:\/\/python\.org/);
  assert.match(out, /web_fetch/);
});

test('formatSearchResults maneja el caso vacío con guía', () => {
  const out = formatSearchResults('asdfqwer', []);
  assert.match(out, /No web results/);
});

test('performWebSearch con query vacía no toca la red y devuelve []', async () => {
  assert.deepEqual(await performWebSearch('   ', 5), []);
});

test('executor web.search con query vacía → error claro (sin red)', async () => {
  const executor = createLocalToolExecutor();
  const res = await executor(
    { tool: 'web.search', arguments: { query: '' } },
    { cwd: process.cwd(), workspaceRoot: process.cwd() },
  );
  assert.equal(res.status, 'error');
  assert.match(res.output, /search query/i);
});

test('web_search está registrado como schema y mapeado a web.search', () => {
  const schema = TOOL_SCHEMAS.find((t) => t.name === 'web_search');
  assert.ok(schema, 'falta el schema web_search');
  assert.ok(schema.parameters.required.includes('query'));
  assert.equal(TOOL_NAME_TO_DOT.web_search, 'web.search');
});

console.log('agent-web-search.test.mjs passed');
