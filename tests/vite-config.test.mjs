import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

await access(new URL('../vite.config.mjs', import.meta.url));

const source = await readFile(new URL('../vite.config.mjs', import.meta.url), 'utf8');

assert.match(source, /@vitejs\/plugin-react/, 'Vite should load the React plugin');
assert.match(source, /@tailwindcss\/vite/, 'Vite should load the Tailwind plugin');
assert.match(source, /react\(\)/, 'Vite config should call react()');
assert.match(source, /tailwindcss\(\)/, 'Vite config should call tailwindcss()');
