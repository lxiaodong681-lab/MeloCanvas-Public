// Validate reviewed texts against the final bundle and native runtime inventory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { publicSuffixPayload } = require('./lib/public-suffix-source.cjs');
const root = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const key = p => `${p.name}@${p.version}`;
function fileReferences(ledger) {
  return [...ledger.npm, ...ledger.workspace, ...ledger.sourceModules, ...ledger.maven].flatMap(p => p.files)
    .concat(ledger.native, ledger.supplements, ledger.sourceMaterials || []);
}
function verify(ledger, directory, bundle, runtime) {
  if (ledger.schemaVersion !== 1 || !ledger.npm.length || !ledger.maven.length || !ledger.native.length) throw Error('Empty or unsupported license ledger');
  const files = new Map();
  for (const item of fileReferences(ledger)) {
    if (!/^(?:licenses\/|android-app\/LICENSE$|LICENSE$)/.test(item.file) || /\\|:|(?:^|\/)\.\.(?:\/|$)/.test(item.file)) throw Error('Unsafe notice path');
    if (item.normalization && item.normalization !== 'LF') throw Error('Unsupported notice normalization');
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || files.has(item.file) && (files.get(item.file).sha256 !== item.sha256 || files.get(item.file).normalization !== item.normalization)) throw Error('Conflicting notice digest');
    files.set(item.file, item);
  }
  for (const [file, item] of files) {
    const bytes = fs.readFileSync(path.join(directory, file));
    if (!bytes.length || sha(item.normalization === 'LF' ? bytes.toString('utf8').replace(/\r\n/g, '\n') : bytes) !== item.sha256) throw Error(`Missing or changed license text: ${file}`);
  }
  for (const group of [ledger.npm, ledger.workspace, ledger.sourceModules, ledger.maven]) {
    if (group.some(p => !p.files?.length)) throw Error('Dependency has no license text');
    const ids = group.map(p => p.coordinate || p.project || key(p));
    if (new Set(ids).size !== ids.length) throw Error('Duplicate dependency entry');
  }
  if (ledger.publicSuffix && sha(publicSuffixPayload(fs.readFileSync(path.join(directory, ledger.publicSuffix.file), 'utf8'))) !== ledger.publicSuffix.payloadSha256) throw Error('Public Suffix List source does not match reviewed binary data');
  if (bundle) {
    if (bundle.unresolvedSources || bundle.projectSources || !bundle.packages.some(p => p.scope === 'bundled-npm-code')) throw Error('Incomplete bundle inventory');
    const allowed = new Map([...ledger.npm, ...ledger.workspace].map(p => [key(p), p]));
    for (const p of bundle.packages) {
      if (p.name === 'expo-application') throw Error('Excluded expo-application is bundled');
      const reviewed = allowed.get(key(p));
      if (!reviewed) throw Error(`Unreviewed bundle package: ${key(p)}`);
      for (const notice of p.notices) if (!reviewed.files.some(f => f.sha256 === notice.sha256)) throw Error(`New or changed package notice: ${key(p)}/${notice.path}`);
    }
  }
  if (runtime) {
    if (!runtime.artifacts?.length || !runtime.localProjects?.length) throw Error('Empty native runtime inventory');
    const allowed = new Map(ledger.maven.map(p => [p.coordinate, p]));
    for (const p of runtime.artifacts) {
      if (/installreferrer|expo.modules.application/.test(p.coordinate)) throw Error('Excluded Install Referrer/Application runtime dependency');
      const reviewed = allowed.get(p.coordinate);
      if (!reviewed || !reviewed.binarySha256.includes(p.sha256)) throw Error(`Unreviewed runtime binary: ${p.coordinate}`);
    }
    for (const project of runtime.localProjects) if (!ledger.sourceModules.some(p => p.project === project)) throw Error(`Unreviewed source module: ${project}`);
  }
  return { status: bundle && runtime ? 'ACTUAL_INVENTORIES_COVERED_NOT_RELEASE_APPROVAL' : 'REVIEWED_TEXTS_VERIFIED', noticeFiles: files.size, bundlePackages: bundle?.packages.length ?? null, runtimeBinaries: runtime?.artifacts.length ?? null };
}
function verifyInstalledModules(ledger) {
  const appRequire = createRequire(path.join(root, 'android-app/apps/mobile/package.json'));
  const expoRequire = createRequire(appRequire.resolve('expo/package.json'));
  for (const p of ledger.sourceModules.filter(p => p.package)) {
    let file;
    try { file = appRequire.resolve(`${p.package}/package.json`); }
    catch { file = expoRequire.resolve(`${p.package}/package.json`); }
    if (JSON.parse(fs.readFileSync(file)).version !== p.version) throw Error(`Changed native source version: ${p.package}`);
  }
}
module.exports = { verify, fileReferences, verifyInstalledModules };
if (require.main === module) {
  try {
    const ledger = JSON.parse(fs.readFileSync(path.join(root, 'release/dependency-licenses.json')));
    const actual = process.argv.includes('--actual');
    const evidence = path.join(root, 'verification/android-ci/dependencies');
    const bundle = actual ? JSON.parse(fs.readFileSync(path.join(evidence, 'bundle-license-evidence.json'))) : null;
    const runtime = actual ? JSON.parse(fs.readFileSync(path.join(evidence, 'runtime-artifacts.json'))) : null;
    if (actual) verifyInstalledModules(ledger);
    const report = verify(ledger, root, bundle, runtime);
    if (actual) fs.writeFileSync(path.join(evidence, 'distribution-license-verification.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
