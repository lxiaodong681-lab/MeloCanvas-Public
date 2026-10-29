const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { collect, inside, assertComplete } = require('../collect-bundle-licenses.cjs');
test('bundle evidence selects actual packages, preserves nested notices and removes machine paths', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'melo-license-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (p, data) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), data); };
  for (const name of ['actual', 'unused-dev']) {
    write(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0', license: 'MIT' }));
    write(`node_modules/${name}/index.js`, 'module.exports = 1');
    write(`node_modules/${name}/LICENSE`, 'Copyright fixture; MIT');
  }
  write('node_modules/actual/native/NOTICE.txt', 'Nested notice');
  write('bundle.map', JSON.stringify({ version: 3, sections: [{ map: { sources: ['node_modules/actual/index.js', 'missing.js'] } }] }));
  const out = path.join(root, 'evidence');
  const result = collect(path.join(root, 'bundle.map'), out, root, root);
  assert.equal(result.unresolvedSources, 1);
  assert.equal(result.status, 'INCOMPLETE_SOURCE_RESOLUTION');
  assert.throws(() => assertComplete(result), /Incomplete Metro license coverage/);
  assert.deepEqual(result.packages.map(p => p.name), ['actual']);
  assert.equal(result.packages[0].notices.length, 2);
  assert.ok(!JSON.stringify(result).includes(root));
  assert.equal(fs.readFileSync(path.join(out, result.packages[0].notices[0].evidenceFile), 'utf8'), 'Copyright fixture; MIT');
  assert.equal(inside(root, path.join(root, '..', 'outside')), false);
});

test('Expo virtual absolute source paths resolve against the configured monorepo server root', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'melo-license-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = path.join(root, 'workspace'), app = path.join(server, 'apps/mobile');
  const pkg = path.join(server, 'node_modules/.pnpm/example@1/node_modules/example');
  fs.mkdirSync(pkg, { recursive: true }); fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'example', version: '1', license: 'MIT' }));
  fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = 1');
  fs.writeFileSync(path.join(pkg, 'LICENSE'), 'Fixture copyright');
  fs.mkdirSync(path.join(pkg, 'esm'));
  fs.writeFileSync(path.join(pkg, 'esm/package.json'), '{"name":"example","type":"module"}');
  fs.writeFileSync(path.join(pkg, 'esm/index.js'), 'export default 1');
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'mobile' }));
  fs.writeFileSync(path.join(app, 'index.js'), 'require("example")');
  const map = path.join(root, 'bundle.map');
  fs.writeFileSync(map, JSON.stringify({ sources: ['__prelude__', '\0polyfill:assets-registry', '/node_modules/.pnpm/example@1/node_modules/example/index.js', '/node_modules/.pnpm/example@1/node_modules/example/esm/index.js', '/apps/mobile/index.js'] }));
  const report = collect(map, path.join(root, 'evidence'), root, app, server);
  assert.equal(report.unresolvedSources, 0);
  assert.deepEqual(report.generatedSources, ['__prelude__', 'polyfill:assets-registry']);
  assert.equal(report.packages[0].sourceCount, 2);
  assert.deepEqual(report.packages.map(p => [p.name, p.scope]), [['example', 'bundled-npm-code'], ['mobile', 'bundled-project-code']]);
  assert.doesNotThrow(() => assertComplete(report));
  assert.ok(!JSON.stringify(report).includes(root));
  fs.writeFileSync(map, JSON.stringify({ sources: ['/unresolved/index.js'] }));
  assert.throws(() => assertComplete(collect(map, path.join(root, 'empty'), root, app, server)), /1\/1 unresolved/);
  fs.writeFileSync(path.join(root, 'outside.js'), 'not bundled');
  fs.writeFileSync(map, JSON.stringify({ sources: ['/../outside.js'] }));
  assert.equal(collect(map, path.join(root, 'escape'), root, app, server).unresolvedSources, 1);
  fs.writeFileSync(map, JSON.stringify({ sources: ['\0polyfill:unknown-generator'] }));
  assert.throws(() => assertComplete(collect(map, path.join(root, 'unknown'), root, app, server)), /1\/1 unresolved/);
});
