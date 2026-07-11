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

// BYOK: la key la trae el usuario. Nada de keys embebidas en el bundle.
assert.doesNotMatch(
  platformSource,
  /embeddedKey|getEmbeddedZenKey/,
  'platform.ts must not depend on an embedded API key (BYOK only)',
);
assert.match(
  platformSource,
  /createNativeAgentRuntime/,
  'platform.ts (Capacitor) should drive the agent with the native function-calling runtime',
);

const serverSource = await readFile(new URL('../server.ts', import.meta.url), 'utf8');
assert.doesNotMatch(
  serverSource,
  /embeddedKey|getEmbeddedZenKey/,
  'server.ts must not depend on an embedded API key (BYOK only)',
);

// El guard BYOK cubre también los módulos del server (donde vive la config ahora).
{
  const { readdir } = await import('node:fs/promises');
  const serverDir = new URL('../src/server/', import.meta.url);
  const files = await readdir(serverDir, { recursive: true });
  for (const file of files) {
    if (!String(file).endsWith('.ts')) continue;
    const source = await readFile(new URL(String(file).replace(/\\/g, '/'), serverDir), 'utf8');
    assert.doesNotMatch(
      source,
      /embeddedKey|getEmbeddedZenKey/,
      `src/server/${file} must not depend on an embedded API key (BYOK only)`,
    );
  }
}

console.log('platform-adapter.test.mjs passed');
