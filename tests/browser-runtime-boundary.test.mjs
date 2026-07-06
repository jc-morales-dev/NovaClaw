import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const runtimeSource = await readFile(new URL('../src/agent/runtime.ts', import.meta.url), 'utf8');
assert.doesNotMatch(
  runtimeSource,
  /from '\.\/tools'/,
  'runtime.ts should not statically import the Node-only local tool executor',
);

const safetySource = await readFile(new URL('../src/agent/safety.ts', import.meta.url), 'utf8');
assert.doesNotMatch(
  safetySource,
  /node:path/,
  'safety.ts should stay browser-safe for the APK runtime bundle',
);

console.log('browser-runtime-boundary.test.mjs passed');
