const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { animations } = require('../prepare-public-assets.cjs');
const root = path.resolve(__dirname, '../..');

test('public asset ledger matches current bytes and excludes retired payee images', () => {
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'release/asset-audit.json')));
  const whitelist = new Set(JSON.parse(fs.readFileSync(path.join(root, 'release/public-source-files.json'))));
  assert.equal(new Set(ledger.assets.map(a => a.path)).size, ledger.assets.length);
  for (const asset of ledger.assets) {
    assert.notEqual(asset.license, 'unresolved', asset.path);
    assert.ok(whitelist.has(asset.path), asset.path);
    const bytes = fs.readFileSync(path.join(root, asset.path));
    assert.equal(bytes.length, asset.size, asset.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.path);
  }
  for (const asset of ledger.excludedAssets) {
    assert.equal(whitelist.has(asset.path), false, asset.path);
    assert.equal(fs.existsSync(path.join(root, asset.path)), false, asset.path);
  }
  // The owner's OC must never inherit the code/icon's MIT grant.
  for (const asset of ledger.assets.filter(a => a.path.includes('/mascot/') && /\.png$/.test(a.path))) {
    assert.equal(asset.license, 'LicenseRef-MeloCanvas-OC');
  }
});

test('replacement animations retain pause/play endpoints and contain only local geometry', () => {
  const generated = animations();
  const [pause, play] = generated['play-pause'].layers;
  assert.deepEqual(pause.ks.o.k.map(k => k.s[0]), [100, 0]);
  assert.deepEqual(play.ks.o.k.map(k => k.s[0]), [0, 100]);
  for (const [name, animation] of Object.entries(generated)) {
    assert.deepEqual(animation.assets, []);
    assert.ok(animation.op > 60);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, `android-app/apps/mobile/src/assets/lottie/${name}.json`))), animation);
    assert.ok(animation.layers.every(l => l.ty === 4 && l.shapes.every(s => ['sh', 'fl'].includes(s.ty))));
  }
  const next = generated['skip-next'].layers[0].shapes[0].ks.k.v;
  const prev = generated['skip-prev'].layers[0].shapes[0].ks.k.v;
  assert.deepEqual(prev, next.map(([x, y]) => [32 - x, y]));
});

test('synthetic decoder fixtures retain palette, Adam7 and ancillary metadata coverage', () => {
  const read = name => fs.readFileSync(path.join(root, `android-app/packages/native/android/src/test/resources/theme-${name}.png`));
  assert.equal(read('palette')[25], 3);
  assert.equal(read('adam7')[28], 1);
  const rgba = read('rgba-icc-text');
  assert.equal(rgba[25], 6);
  const chunks = [];
  for (let offset = 8; offset < rgba.length;) {
    const size = rgba.readUInt32BE(offset);
    chunks.push(rgba.subarray(offset + 4, offset + 8).toString());
    offset += size + 12;
    assert.ok(offset <= rgba.length);
  }
  for (const type of ['iCCP', 'zTXt', 'iTXt']) assert.ok(chunks.includes(type), type);
});
