import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const {
  createBootstrapStatus,
  getBootstrapProgressValue,
  isBootstrapBlocking,
} = await import('../src/bootstrap/state.ts');

const checking = createBootstrapStatus({ phase: 'checking', message: 'Checking runtime...' });
assert.equal(checking.phase, 'checking');
assert.equal(isBootstrapBlocking(checking), true);
assert.equal(getBootstrapProgressValue(checking), null);

const downloading = createBootstrapStatus({
  phase: 'downloading',
  message: 'Downloading runtime...',
  progress: 52,
});
assert.equal(isBootstrapBlocking(downloading), true);
assert.equal(getBootstrapProgressValue(downloading), 52);

const ready = createBootstrapStatus({ phase: 'ready', message: 'Runtime ready.' });
assert.equal(isBootstrapBlocking(ready), false);
assert.equal(getBootstrapProgressValue(ready), 100);

const failed = createBootstrapStatus({
  phase: 'error',
  message: 'Install failed.',
  error: 'network timeout',
});
assert.equal(isBootstrapBlocking(failed), true);
assert.equal(getBootstrapProgressValue(failed), null);

const splashSource = await readFile(new URL('../src/components/SplashScreen.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(
  splashSource,
  /localStorage\.getItem\('nova_first_launch'\)|simulate fast download\/installation progress|setInterval\(/,
  'SplashScreen should be driven by bootstrap state instead of fake timed progress',
);
assert.match(
  splashSource,
  /status\./,
  'SplashScreen should render based on the shared bootstrap status',
);

console.log('bootstrap-state.test.mjs passed');
