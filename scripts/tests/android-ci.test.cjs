const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { expectedMetadata, assertBadging, fingerprint } = require('../android-ci.cjs');
const config = { version: '1.2.3', android: { versionCode: 42, package: 'org.melocanvas.app' } };
const gradle = `applicationId 'org.melocanvas.app'\nversionCode 42\nversionName "1.2.3"`;
const expected = { version: '1.2.3', versionCode: 42, packageName: 'org.melocanvas.app' };
const badging = `package: name='org.melocanvas.app' versionCode='42' versionName='1.2.3' platformBuildVersionName='16'\nnative-code: 'arm64-v8a'\n`;

test('metadata follows source version instead of the upstream package.json version', () => {
  assert.deepEqual(expectedMetadata(config, gradle), expected);
  for (const changed of [gradle.replace('42', '41'), gradle.replace('1.2.3', '1.2.2'), gradle.replace('org.melocanvas.app', 'other.app')]) {
    assert.throws(() => expectedMetadata(config, changed), /disagree/);
  }
});
test('APK badging rejects a wrong package, version, ABI or debuggable build', () => {
  assert.doesNotThrow(() => assertBadging(badging, expected));
  for (const changed of [badging.replace('42', '41'), badging.replace('1.2.3', '1.2.2'),
    badging.replace('org.melocanvas.app', 'other.app'), badging.replace('arm64-v8a', 'x86_64'),
    badging.replace("'arm64-v8a'", "'arm64-v8a' 'x86_64'"), badging + 'application-debuggable\n']) {
    assert.throws(() => assertBadging(changed, expected));
  }
});
test('certificate pin accepts conventional SHA-256 formats and rejects missing or invalid pins', () => {
  const digest = 'ab'.repeat(32);
  assert.equal(fingerprint(digest.toUpperCase().match(/../g).join(':')), digest);
  for (const value of ['', undefined, 'ab'.repeat(20), 'xy'.repeat(32)]) assert.throws(() => fingerprint(value), /original APK/);
});
test('Expo prebuild preserves the checked-in CI signing policy', () => {
  const mobile = path.resolve(__dirname, '../../android-app/apps/mobile');
  const plugin = fs.readFileSync(path.join(mobile, 'expo-plugins/withMeloAndroid.js'), 'utf8');
  const generated = fs.readFileSync(path.join(mobile, 'android/app/build.gradle'), 'utf8');
  const marker = '// Internal review signing is separate from the experimental/debug key.';
  assert.equal(plugin.slice(plugin.lastIndexOf(marker), plugin.indexOf('\n`', plugin.lastIndexOf(marker))).replaceAll('\r\n', '\n').trim(),
    generated.slice(generated.indexOf(marker)).replaceAll('\r\n', '\n').trim());
  assert.match(generated, /else if \(System.getenv\('MELO_KEYSTORE'\)\)/);
  assert.match(generated, /throw new GradleException\('Internal builds require/);
});
