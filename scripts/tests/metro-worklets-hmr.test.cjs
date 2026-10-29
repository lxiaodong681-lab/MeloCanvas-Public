const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { runInNewContext } = require('node:vm');
const { test } = require('node:test');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const patch = readFileSync(path.join(root, 'android-app/patches/metro-runtime@0.84.5.patch'), 'utf8').replace(/\r\n/g, '\n');
// Execute the actual first patch hunk, completing only its unchanged eval branch.
const hunk = patch.split(/@@[^\n]*\n/)[1].split('\n').filter(line => line.startsWith(' ') || line.startsWith('+')).map(line => line.slice(1)).join('\n');
const inject = hunk.slice(hunk.indexOf('const inject =')) + '\n eval(code);\n }\n}; inject(update);';
for (const mode of [undefined, false, true]) {
  test(`HMR forwards to Worklets only in Bundle Mode (${mode})`, () => {
    const calls = [];
    runInNewContext(inject, {
      global: {
        _WORKLETS_BUNDLE_MODE_ENABLED: mode,
        __workletsModuleProxy: { propagateModuleUpdate: (...args) => calls.push(['worklets', ...args]) },
        globalEvalWithSourceUrl: (...args) => calls.push(['js', ...args]),
      },
      update: { module: [17, 'newModule()'], sourceURL: 'ui.tsx' },
    });
    assert.deepEqual(calls, [...(mode === true ? [['worklets', 'newModule()', 'ui.tsx']] : []), ['js', 'newModule()', 'ui.tsx']]);
  });
}
test('Bundle Mode tolerates an absent Worklets runtime and retains ordinary evaluation', () => {
  const calls = [];
  runInNewContext(inject, {global: {_WORKLETS_BUNDLE_MODE_ENABLED: true, globalEvalWithSourceUrl: (...args) => calls.push(args)}, update: {module: [1, 'x'], sourceURL: 'x.js'}});
  assert.deepEqual(calls, [['x', 'x.js']]);
});
test('lockfile pins the normalized patch hash', () => {
  const hash = createHash('sha256').update(patch).digest('hex');
  assert.ok(readFileSync(path.join(root, 'android-app/pnpm-lock.yaml'), 'utf8').includes(`metro-runtime@0.84.5: ${hash}`));
});
