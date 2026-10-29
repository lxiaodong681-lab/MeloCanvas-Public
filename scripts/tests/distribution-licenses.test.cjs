const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { verify } = require('../verify-distribution-licenses.cjs');
test('final inventories must have reviewed versions, intact texts and exact native binaries', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'melo-distribution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'licenses')); fs.writeFileSync(path.join(root, 'licenses/MIT.txt'), 'Copyright fixture. MIT license text.');
  const file = { file: 'licenses/MIT.txt', sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'licenses/MIT.txt'))).digest('hex') };
  const ledger = { schemaVersion: 1, npm: [{ name: 'actual', version: '1', files: [file] }], workspace: [], sourceModules: [{ project: ':native', files: [file] }], maven: [{ coordinate: 'group:lib:1', binarySha256: ['a'.repeat(64)], files: [file] }], native: [file], supplements: [] };
  const bundle = { unresolvedSources: 0, projectSources: 0, packages: [{ name: 'actual', version: '1', scope: 'bundled-npm-code', notices: [{ path: 'LICENSE', sha256: file.sha256 }] }] };
  const runtime = { artifacts: [{ coordinate: 'group:lib:1', sha256: 'a'.repeat(64) }], localProjects: [':native'] };
  assert.equal(verify(ledger, root, bundle, runtime).status, 'ACTUAL_INVENTORIES_COVERED_NOT_RELEASE_APPROVAL');
  const change = (target, edit) => { const copy = structuredClone(target); edit(copy); return copy; };
  for (const edit of [b => { b.packages[0].version = '2'; }, b => { b.packages[0].notices[0].sha256 = 'b'.repeat(64); }, b => { b.unresolvedSources = 1; }, b => { b.packages = []; }, b => { b.packages[0].name = 'expo-application'; }]) assert.throws(() => verify(ledger, root, change(bundle, edit), runtime));
  for (const edit of [r => { r.artifacts[0].sha256 = 'b'.repeat(64); }, r => { r.artifacts[0].coordinate = 'com.android.installreferrer:installreferrer:2.2'; }, r => { r.localProjects.push(':unreviewed'); }]) assert.throws(() => verify(ledger, root, bundle, change(runtime, edit)));
  assert.throws(() => verify(change(ledger, l => { l.npm[0].files = []; }), root, bundle, runtime), /no license text/);
  fs.appendFileSync(path.join(root, 'licenses/MIT.txt'), ' changed');
  assert.throws(() => verify(ledger, root, bundle, runtime), /changed license text/);
});

test('Public Suffix source reconstructs the published payload and catches list changes', () => {
  const { publicSuffixPayload } = require('../lib/public-suffix-source.cjs');
  const root = path.resolve(__dirname, '../..');
  const proof = JSON.parse(fs.readFileSync(path.join(root, 'release/public-suffix-source.json')));
  const source = fs.readFileSync(path.join(root, proof.file), 'utf8');
  const hash = text => crypto.createHash('sha256').update(publicSuffixPayload(text)).digest('hex');
  assert.equal(hash(source), proof.payloadSha256);
  assert.notEqual(hash(source + '\nexample.invalid\n'), proof.payloadSha256);
  assert.equal(hash(source + '\n// Documentation-only change\n'), proof.payloadSha256);
});
