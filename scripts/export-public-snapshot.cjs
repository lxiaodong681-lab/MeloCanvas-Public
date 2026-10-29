// Export reviewed blobs only. Never copy .git, local files, ignored evidence or identities.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { inspect } = require('./check-public-source.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function safePath(file) {
  return typeof file === 'string' && file.length > 0 && !file.includes('\\') && !file.includes(':') &&
    !file.startsWith('/') && file.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}
function exportSnapshot(root, output, ref = 'HEAD') {
  const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const revision = git(['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim();
  const list = JSON.parse(git(['show', `${revision}:release/public-source-files.json`]).toString());
  if (!Array.isArray(list) || !list.length || new Set(list.map(x => x.toLowerCase())).size !== list.length || !list.every(safePath))
    throw new Error('Invalid or ambiguous public source allowlist');
  const entries = new Map(git(['ls-tree', '-rz', revision]).toString().split('\0').filter(Boolean).map(line => {
    const [meta, file] = line.split('\t'); return [file, meta.split(' ')];
  }));
  output = path.resolve(output);
  // Refuse existing destinations, including symlinks; no overwrite or cleanup is performed.
  if (fs.existsSync(output)) throw new Error('Snapshot destination must not exist');
  const files = [];
  for (const file of list) {
    const entry = entries.get(file);
    if (!entry || !['100644', '100755'].includes(entry[0]) || entry[1] !== 'blob') throw new Error(`Missing or non-regular source: ${file}`);
    const bytes = git(['cat-file', 'blob', entry[2]]);
    if (inspect(file, bytes).length) throw new Error(`Public source check failed: ${file}`);
    files.push({ path: file, mode: entry[0], sha256: hash(bytes), bytes });
  }
  const records = files.map(({ bytes, ...item }) => item);
  const snapshotId = hash(JSON.stringify(records));
  fs.mkdirSync(output, { recursive: true });
  for (const item of files) {
    const target = path.join(output, item.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, item.bytes, { flag: 'wx', mode: item.mode === '100755' ? 0o755 : 0o644 });
  }
  const manifest = { version: '0.19.4', build: 35, status: 'LOCAL_REVIEW_ONLY', snapshotId, files: records };
  fs.writeFileSync(path.join(output, 'SOURCE_SNAPSHOT.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { snapshotId, files: files.length, output };
}
if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node scripts/export-public-snapshot.cjs NEW_DIRECTORY [COMMIT]');
    console.log(JSON.stringify(exportSnapshot(path.resolve(__dirname, '..'), process.argv[2], process.argv[3]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { safePath, exportSnapshot };
