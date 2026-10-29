const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { safePath, verifyBytes, verifyInventory, verifyDex } = require('../verify-lgpl-relink.cjs');
test('relink proof rejects unsafe paths, changed sources and original cached Maven binaries', () => {
  for (const p of ['../x', 'x/../y', '/x', 'C:/x', '.git/config', 'a\\b']) assert.equal(safePath(p), false);
  assert.equal(safePath('api/src/main/java/Library.java'), true);
  const bytes = Buffer.from('verified source'), digest = createHash('sha256').update(bytes).digest('hex');
  verifyBytes(bytes, digest, 'fixture');
  assert.throws(() => verifyBytes(Buffer.from('changed source'), digest, 'fixture'), /checksum mismatch/);
  const artifact = { coordinate: 'file:replacement.jar', sha256: digest };
  verifyInventory({ artifacts: [artifact] }, { 'replacement.jar': digest });
  assert.throws(() => verifyInventory({ artifacts: [] }, { 'replacement.jar': digest }), /missing/);
  assert.throws(() => verifyInventory({ artifacts: [{ ...artifact, sha256: 'wrong' }] }, { 'replacement.jar': digest }), /incorrect/);
  assert.throws(() => verifyInventory({ artifacts: [artifact, { coordinate: 'net.jthink:jaudiotagger:3.0.1' }] }, { 'replacement.jar': digest }), /Original/);
});
test('both independently rebuilt library classes must reach DEX', () => {
  const first = Buffer.from('Lorg/melocanvas/relink/SuperLyricProof;');
  assert.throws(() => verifyDex(first), /JaudiotaggerProof/);
  verifyDex(Buffer.concat([first, Buffer.from('Lorg/melocanvas/relink/JaudiotaggerProof;')]));
});
