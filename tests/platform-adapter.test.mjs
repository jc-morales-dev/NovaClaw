import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pagePaths = [
  new URL('../src/pages/Home.tsx', import.meta.url),
  new URL('../src/pages/ChatView.tsx', import.meta.url),
  new URL('../src/pages/TerminalView.tsx', import.meta.url),
  new URL('../src/pages/LogViewer.tsx', import.meta.url),
];

for (const pagePath of pagePaths) {
  const source = await readFile(pagePath, 'utf8');
  assert.doesNotMatch(
    source,
    /fetch\((['"])\/api\//,
    `${pagePath.pathname} should use the platform client instead of raw /api fetch calls`,
  );
  assert.match(
    source,
    /platform\./,
    `${pagePath.pathname} should call the shared platform adapter`,
  );
}

const platformSource = await readFile(new URL('../src/platform.ts', import.meta.url), 'utf8');
assert.match(platformSource, /export const platform/, 'platform.ts should export the shared platform client');

console.log('platform-adapter.test.mjs passed');
