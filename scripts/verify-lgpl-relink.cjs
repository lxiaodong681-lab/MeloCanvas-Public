// Private CI proof only: compile the pinned LGPL sources, then verify local replacements in DEX.
// Never signs, installs, publishes or overwrites the original retained candidate APK.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const mobile = path.join(root, 'android-app/apps/mobile');
const req = createRequire(path.join(mobile, 'package.json'));
const work = path.join(root, 'verification/android-ci/lgpl-relink');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const markers = ['org/melocanvas/relink/SuperLyricProof', 'org/melocanvas/relink/JaudiotaggerProof'];
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release/lgpl-materials.json')));

function safePath(name) {
  return typeof name === 'string' && !/[\\:]/.test(name) && !name.startsWith('/') &&
    name.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}
function verifyBytes(bytes, digest, label) {
  if (sha(bytes) !== digest) throw new Error(`Source checksum mismatch: ${label}`);
}
async function download(url, digest) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Source download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest) verifyBytes(bytes, digest, url);
  return bytes;
}
function write(base, name, bytes) {
  if (!safePath(name)) throw new Error('Unsafe archive member');
  const file = path.join(base, name);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
function run(command, args, cwd, javaHome) {
  const result = cp.spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, JAVA_HOME: javaHome } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed (${result.status}): ${path.basename(command)}`);
}
async function prepare() {
  if (fs.existsSync(work)) throw new Error('Use a fresh CI checkout; existing relink evidence is never overwritten');
  const JSZip = req('jszip');
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'release/superlyric-source-files.json')));
  const bytes = await download(`https://codeload.github.com/HChenX/SuperLyricApi/zip/${manifest.superLyricApiCommit}`);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const prefix = `SuperLyricApi-${manifest.superLyricApiCommit}/`;
  const files = Object.values(zip.files).filter(e => !e.dir);
  if (files.length !== expected.length) throw new Error('Unexpected SuperLyric source file count');
  const superRoot = path.join(work, 'SuperLyricApi');
  for (const item of expected) {
    const entry = zip.file(prefix + item.path);
    if (!entry || entry.unsafeOriginalName !== prefix + item.path) throw new Error('Missing or unsafe pinned source member');
    const data = await entry.async('nodebuffer'); verifyBytes(data, item.sha256, item.path); write(superRoot, item.path, data);
  }
  const source = manifest.files.find(f => f.name === 'jaudiotagger-3.0.1-sources.jar');
  const sourceBytes = await download(source.source, source.sha256);
  const sourceZip = await JSZip.loadAsync(sourceBytes, { checkCRC32: true });
  const jaudioRoot = path.join(work, 'jaudiotagger/src');
  for (const entry of Object.values(sourceZip.files).filter(e => !e.dir)) {
    if (entry.unsafeOriginalName !== entry.name) throw new Error('Unsafe jaudiotagger source member');
    write(jaudioRoot, entry.name, await entry.async('nodebuffer'));
  }
  if (walk(jaudioRoot).filter(f => f.endsWith('.java')).length !== 551) throw new Error('Unexpected jaudiotagger source count');
  const pom = manifest.files.find(f => f.name === 'jaudiotagger-3.0.1.pom');
  write(path.join(work, 'jaudiotagger'), 'pom.xml', await download(pom.source, pom.sha256));
  // Additional independent classes distinguish our rebuild from the cached original libraries.
  for (const [base, name] of [[path.join(superRoot, 'api/src/main/java'), 'SuperLyricProof'], [jaudioRoot, 'JaudiotaggerProof']]) {
    write(base, `org/melocanvas/relink/${name}.java`, `// MeloCanvas CI verification addition, 2026-10-28; LGPL-2.1-or-later.\npackage org.melocanvas.relink;\npublic final class ${name} { public static String proof() { return "MeloCanvas LGPL relink proof 2026-10-28"; } }\n`);
  }
  write(work, 'MODIFICATIONS.txt', '2026-10-28: CI verification copies only. Original library sources are unchanged; added org.melocanvas.relink.SuperLyricProof and JaudiotaggerProof classes under LGPL-2.1-or-later to prove their rebuilt bytecode reaches DEX. These are not the official candidate libraries. No signing or device acceptance.\n');
  write(work, 'LGPL-2.1.txt', fs.readFileSync(path.join(root, 'licenses/LGPL-2.1.txt')));
  const jdk21 = process.env.JAVA_HOME, jdk17 = process.env.JAVA_HOME_17_X64;
  if (!jdk21 || !jdk17 || process.platform === 'win32') throw new Error('Run in Linux CI with JDK 21 and JAVA_HOME_17_X64');
  run('bash', ['./gradlew', ':api:assembleRelease', '--no-daemon', '--max-workers=2', '--console=plain'], superRoot, jdk21);
  const classes = path.join(work, 'jaudiotagger/classes'); fs.mkdirSync(classes);
  const javaFiles = walk(jaudioRoot).filter(f => f.endsWith('.java'));
  const args = path.join(work, 'jaudiotagger/sources.txt');
  fs.writeFileSync(args, javaFiles.map(f => JSON.stringify(f)).join('\n'));
  run(path.join(jdk17, 'bin/javac'), ['--release', '8', '-encoding', 'UTF-8', '-d', classes, '@' + args], root, jdk17);
  for (const file of walk(jaudioRoot).filter(f => !f.endsWith('.java'))) write(classes, path.relative(jaudioRoot, file).split(path.sep).join('/'), fs.readFileSync(file));
  run(path.join(jdk17, 'bin/jar'), ['--create', '--file', path.join(work, 'jaudiotagger-rebuilt.jar'), '-C', classes, '.'], root, jdk17);
  fs.copyFileSync(path.join(superRoot, 'api/build/outputs/aar/api-release.aar'), path.join(work, 'SuperLyricApi-rebuilt.aar'));
  // Retain only portable source inputs and modification evidence, not build paths/cache.
  const evidence = new JSZip();
  for (const item of expected) evidence.file('SuperLyricApi/' + item.path, fs.readFileSync(path.join(superRoot, item.path)));
  evidence.file('SuperLyricApi/api/src/main/java/org/melocanvas/relink/SuperLyricProof.java', fs.readFileSync(path.join(superRoot, 'api/src/main/java/org/melocanvas/relink/SuperLyricProof.java')));
  for (const file of walk(jaudioRoot)) evidence.file('jaudiotagger/src/' + path.relative(jaudioRoot, file).split(path.sep).join('/'), fs.readFileSync(file));
  for (const file of ['MODIFICATIONS.txt', 'LGPL-2.1.txt', 'jaudiotagger/pom.xml']) evidence.file(file, fs.readFileSync(path.join(work, file)));
  fs.writeFileSync(path.join(work, 'verification-sources.zip'), await evidence.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
function verifyInventory(inventory, replacements) {
  for (const [name, digest] of Object.entries(replacements)) {
    if (!inventory.artifacts.some(a => a.coordinate === 'file:' + name && a.sha256 === digest)) throw new Error('Local replacement missing or incorrect: ' + name);
  }
  if (inventory.artifacts.some(a => /^(?:com\.github\.HChenX:SuperLyricApi|net\.jthink:jaudiotagger):/.test(a.coordinate))) throw new Error('Original LGPL Maven binary remains');
}
function verifyDex(bytes) {
  for (const marker of markers) if (!bytes.includes(Buffer.from(marker))) throw new Error('Missing rebuilt DEX class: ' + marker);
}
async function verify() {
  const JSZip = req('jszip');
  const apk = fs.readFileSync(path.join(mobile, 'android/app/build/outputs/apk/release/app-release-unsigned.apk'));
  const zip = await JSZip.loadAsync(apk, { checkCRC32: true });
  const dex = await Promise.all(Object.values(zip.files).filter(f => /^classes\d*\.dex$/.test(f.name)).map(f => f.async('nodebuffer')));
  verifyDex(Buffer.concat(dex));
  const replacements = Object.fromEntries(['SuperLyricApi-rebuilt.aar', 'jaudiotagger-rebuilt.jar'].map(n => [n, sha(fs.readFileSync(path.join(work, n)))]));
  verifyInventory(JSON.parse(fs.readFileSync(path.join(work, 'runtime-artifacts.json'))), replacements);
  const report = { status: 'RELINK_BYTECODE_VERIFIED_NOT_DEVICE_TESTED', commit: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), apkSha256: sha(apk), replacements, sourceArchiveSha256: sha(fs.readFileSync(path.join(work, 'verification-sources.zip'))), verifiedDexClasses: markers, signed: false, installed: false };
  fs.writeFileSync(path.join(work, 'relink-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
module.exports = { safePath, verifyBytes, verifyInventory, verifyDex };
if (require.main === module) Promise.resolve().then(() => {
  if (process.argv[2] === 'prepare') return prepare();
  if (process.argv[2] === 'verify') return verify();
  throw new Error('Use prepare or verify');
}).catch(error => { console.error(error); process.exitCode = 1; });
