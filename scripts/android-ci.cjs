// Shared CI metadata, regression runner, APK verification and signing. No EAS account needed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const mobile = path.join(root, 'android-app/apps/mobile');
const mobileRequire = createRequire(path.join(mobile, 'package.json'));
const ci = path.join(root, 'verification/android-ci');

function expectedMetadata(config, gradle) {
  const version = gradle.match(/\bversionName\s+"([^"]+)"/)?.[1];
  const versionCode = Number(gradle.match(/\bversionCode\s+(\d+)/)?.[1]);
  const packageName = gradle.match(/\bapplicationId\s+'([^']+)'/)?.[1];
  if (!version || !versionCode || !packageName || version !== config.version ||
      versionCode !== config.android?.versionCode || packageName !== config.android?.package) {
    throw new Error('Expo and committed Android version/package disagree; update both before building.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) throw new Error('Unsafe version filename');
  return { version, versionCode, packageName };
}

function metadata() {
  const { getConfig } = mobileRequire('expo/config');
  const config = getConfig(mobile, { skipPlugins: true, skipSDKVersionRequirement: true }).exp;
  const expected = expectedMetadata(config, fs.readFileSync(path.join(mobile, 'android/app/build.gradle'), 'utf8'));
  const rn = path.dirname(mobileRequire.resolve('react-native/package.json'));
  const catalog = fs.readFileSync(path.join(rn, 'gradle/libs.versions.toml'), 'utf8');
  const properties = fs.readFileSync(path.join(mobile, 'android/gradle.properties'), 'utf8');
  const version = (name, property) => properties.match(new RegExp(`^${property.replaceAll('.', '\\.')}=(.+)$`, 'm'))?.[1].trim() ||
    catalog.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm'))?.[1];
  const buildTools = version('buildTools', 'android.buildToolsVersion');
  const compileSdk = version('compileSdk', 'android.compileSdkVersion');
  const ndk = version('ndkVersion', 'android.ndkVersion');
  const cmake = properties.match(/^android\.cmakeVersion=(.+)$/m)?.[1].trim() || '3.22.1';
  for (const value of [buildTools, compileSdk, ndk, cmake]) {
    if (!value || !/^[\d.]+$/.test(value)) throw new Error('Cannot resolve Android toolchain versions');
  }
  // An exported archive may be nested in a private checkout; never inherit its Git identity.
  const snapshotFile = path.join(root, 'SOURCE_SNAPSHOT.json');
  const commit = fs.existsSync(snapshotFile)
    ? JSON.parse(fs.readFileSync(snapshotFile, 'utf8')).snapshotId
    : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) throw new Error('Invalid source revision');
  const result = { ...expected, commit, buildTools, compileSdk, ndk, cmake };
  fs.mkdirSync(ci, { recursive: true });
  fs.writeFileSync(path.join(ci, 'metadata.json'), JSON.stringify(result, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries(result)) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
}

function regressions() {
  // Resolve sharp from the frozen workspace install, not the developer's vendor cache.
  const expoRequire = createRequire(mobileRequire.resolve('expo/package.json'));
  const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
  const imageRequire = createRequire(cliRequire.resolve('@expo/image-utils/package.json'));
  const sharp = imageRequire.resolve('sharp');
  const files = fs.readdirSync(path.join(mobile, 'melo/tests')).filter(name => name.endsWith('.test.ts'));
  if (!files.length) throw new Error('No mobile regression tests discovered');
  const result = spawnSync(process.execPath, [mobileRequire.resolve('tsx/cli'), '--test', '--test-reporter=tap',
    ...files.map(name => path.join(mobile, 'melo/tests', name))], {
    cwd: root, stdio: 'inherit', env: { ...process.env, MELO_THEME_SHARP: sharp },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Mobile regressions failed (${result.status})`);
  // Test infrastructure that is portable; android-build.test.cjs exercises Windows .bat files locally.
  const checks = [path.join(root, 'scripts/tests/metro-worklets-hmr.test.cjs'),
    path.join(root, 'scripts/tests/android-ci.test.cjs'),
    ...fs.readdirSync(path.join(mobile, 'expo-plugins')).filter(name => name.endsWith('.test.cjs')).map(name => path.join(mobile, 'expo-plugins', name))];
  const checked = spawnSync(process.execPath, ['--test', ...checks], { cwd: root, stdio: 'inherit' });
  if (checked.error) throw checked.error;
  if (checked.status !== 0) throw new Error('Build/plugin regression checks failed');
}

function assertBadging(badging, expected) {
  const pkg = badging.match(/^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m);
  if (!pkg || pkg[1] !== expected.packageName || Number(pkg[2]) !== expected.versionCode || pkg[3] !== expected.version) {
    throw new Error('APK package/version differs from source metadata');
  }
  if (/^application-debuggable/m.test(badging)) throw new Error('APK must be a non-debuggable Release');
  const abis = [...(badging.match(/^native-code: (.+)$/m)?.[1] || '').matchAll(/'([^']+)'/g)].map(x => x[1]);
  if (abis.join(',') !== 'arm64-v8a') throw new Error('APK must contain only arm64-v8a');
}

function fingerprint(value) {
  const result = (value || '').replaceAll(':', '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('MELO_SIGNING_CERT_SHA256 must be the original APK certificate SHA-256');
  return result;
}

async function verify(file, signed, outputDirectory) {
  const expected = JSON.parse(fs.readFileSync(path.join(ci, 'metadata.json')));
  const tools = path.join(process.env.ANDROID_HOME, 'build-tools', expected.buildTools);
  const badging = execFileSync(path.join(tools, 'aapt'), ['dump', 'badging', file], { encoding: 'utf8' });
  assertBadging(badging, expected);
  execFileSync(path.join(tools, 'zipalign'), ['-c', '-P', '16', '-v', '4', file]);
  const bytes = fs.readFileSync(file);
  const JSZip = mobileRequire('jszip');
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const abis = [...new Set(Object.keys(zip.files).filter(name => /^lib\/[^/]+\//.test(name)).map(name => name.split('/')[1]))];
  if (abis.join(',') !== 'arm64-v8a' || !zip.file('classes.dex')) throw new Error('Missing DEX or incorrect native libraries');
  const bundle = await zip.file('assets/index.android.bundle')?.async('nodebuffer');
  if (bundle?.subarray(0, 8).toString('hex') !== 'c61fbc03c103191f') throw new Error('Missing embedded Hermes bytecode');
  const suffix = JSON.parse(fs.readFileSync(path.join(root, 'release/public-suffix-source.json')));
  const suffixBytes = await zip.file(suffix.archiveEntry)?.async('nodebuffer');
  if (!suffixBytes || crypto.createHash('sha256').update(require('node:zlib').gunzipSync(suffixBytes)).digest('hex') !== suffix.payloadSha256) throw new Error('APK Public Suffix List differs from the supplied MPL source');
  for (const name of Object.keys(zip.files).filter(name => /^classes\d*\.dex$/.test(name))) {
    const dex = await zip.file(name).async('nodebuffer');
    if (dex.includes(Buffer.from('expo/modules/orpheus/lab/'))) throw new Error('Diagnostic activity found in APK');
    if (['com/android/installreferrer/', 'expo/modules/application/'].some(prefix => dex.includes(Buffer.from(prefix)))) throw new Error('Excluded Install Referrer/Application code found in APK');
  }
  let certificateSha256 = null;
  if (signed) {
    const report = execFileSync(path.join(tools, 'apksigner'), ['verify', '--verbose', '--print-certs', file], { encoding: 'utf8' });
    const certs = [...report.matchAll(/^Signer #\d+ certificate SHA-256 digest: (\w+)$/gm)];
    if (certs.length !== 1 || fingerprint(certs[0][1]) !== fingerprint(process.env.MELO_SIGNING_CERT_SHA256)) throw new Error('APK certificate does not match the original internal APK');
    certificateSha256 = fingerprint(certs[0][1]);
  } else {
    const check = spawnSync(path.join(tools, 'apksigner'), ['verify', file], { encoding: 'utf8' });
    if (check.error) throw check.error;
    if (check.status === 0) throw new Error('Expected unsigned CI APK');
  }
  const name = `MeloCanvas-v${expected.version}-${expected.versionCode}-${expected.commit.slice(0, 12)}-arm64-v8a-${signed ? 'release' : 'UNSIGNED'}.apk`;
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.copyFileSync(file, path.join(outputDirectory, name));
  fs.writeFileSync(path.join(outputDirectory, `${name}.sha256`), `${sha256}  ${name}\n`);
  fs.writeFileSync(path.join(outputDirectory, 'apk-verification.json'), JSON.stringify({ ...expected, filename: name,
    signed, certificateSha256, sha256, bytes: bytes.length, abis, embeddedBundleBytes: bundle.length,
    hermesBytecode: true, zipCrcVerified: true, zipAligned: true }, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `artifact=${name.slice(0, -4)}\n`);
  console.log(`${name}\nSHA-256: ${sha256}\n${signed ? 'Original internal certificate verified' : 'UNSIGNED: verification only, cannot install'}`);
}

async function sign() {
  const expected = JSON.parse(fs.readFileSync(path.join(ci, 'metadata.json')));
  const encoded = (process.env.MELO_KEYSTORE_BASE64 || '').replace(/\s/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || !process.env.MELO_KEYSTORE_PASSWORD) throw new Error('Missing or invalid original signing secrets');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('Invalid keystore Base64');
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'melo-signing-'));
  const key = path.join(dir, 'internal.keystore');
  const apk = path.join(dir, 'signed.apk');
  try {
    fs.writeFileSync(key, bytes, { mode: 0o600 });
    const cert = execFileSync('keytool', ['-exportcert', '-keystore', key, '-alias', 'melocanvas-internal',
      '-storepass:env', 'MELO_KEYSTORE_PASSWORD'], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (crypto.createHash('sha256').update(cert).digest('hex') !== fingerprint(process.env.MELO_SIGNING_CERT_SHA256)) throw new Error('Keystore certificate does not match the original internal APK');
    execFileSync(path.join(process.env.ANDROID_HOME, 'build-tools', expected.buildTools, 'apksigner'), [
      'sign', '--ks', key, '--ks-key-alias', 'melocanvas-internal', '--ks-pass', 'env:MELO_KEYSTORE_PASSWORD',
      '--key-pass', 'env:MELO_KEYSTORE_PASSWORD', '--out', apk,
      path.join(mobile, 'android/app/build/outputs/apk/release/app-release-unsigned.apk'),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await verify(apk, true, path.join(ci, 'release'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { expectedMetadata, assertBadging, fingerprint };
if (require.main === module) {
  Promise.resolve().then(() => {
    switch (process.argv[2]) {
      case 'metadata': return metadata();
      case 'test': return regressions();
      case 'verify-unsigned': return verify(path.join(mobile, 'android/app/build/outputs/apk/release/app-release-unsigned.apk'), false, path.join(ci, 'unsigned'));
      case 'sign': return sign();
      default: throw new Error('Use metadata, test, verify-unsigned or sign');
    }
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
