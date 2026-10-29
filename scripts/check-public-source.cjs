// A narrow, fail-closed guard for the current source tree, NOT a history/privacy clearance.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

function inspect(relative, bytes) {
  const file = relative.replaceAll('\\', '/').toLowerCase();
  const issues = [];
  if (/^(?:verification|artifacts|test-snapshots|\.codex-remote-attachments)\//.test(file) ||
      /^experiments\/phase2\/(?:results|artifacts|private|vendor)\//.test(file) ||
      /^design-prototype\/references\/bbplayer\//.test(file) ||
      /^android-app\/assets\/screenshots\//.test(file) ||
      /^android-app\/apps\/mobile\/assets\/config\/google-services\//.test(file) ||
      /(?:^|\/)\.gitleaks-baseline\.json$/.test(file) ||
      /^android-app\/packages\/splash\/src\/__tests__\/fixtures\/(?:687506|bilibili--bv1zu411x7mc)\.json$/.test(file) ||
      /(?:^|\/)\.env(?:\..+)?$/.test(file) && !file.endsWith('/.env.example') && file !== '.env.example' ||
      /\.(?:apk|aab|keystore|jks|p12|pfx|mobileprovision)$/.test(file)) {
    issues.push({ rule: 'private-or-built-artifact' });
  }
  // Also inspect text containing NULs (e.g. UTF-16 logs); do not print matched values.
  const text = bytes[0] === 255 && bytes[1] === 254 ? bytes.toString('utf16le') : bytes.toString('utf8');
  for (const [rule, pattern] of [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    ['service-token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sntry[su]_[A-Za-z0-9_+/=-]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{30,})/],
  ]) {
    const match = pattern.exec(text);
    if (match) issues.push({ rule, line: text.slice(0, match.index).split('\n').length });
  }
  return issues;
}

function check(root) {
  const snapshotPath = path.join(root, 'SOURCE_SNAPSHOT.json');
  const snapshot = fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) : null;
  const files = snapshot ? snapshot.files.map(entry => entry.path)
    : execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean);
  const findings = [];
  for (const [index, file] of files.entries()) {
    if (typeof file !== 'string' || /[\\:]/.test(file) || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('Invalid source manifest path');
    // Missing tracked files fail rather than silently reducing the scan scope.
    const bytes = fs.readFileSync(path.join(root, file));
    if (snapshot && createHash('sha256').update(bytes).digest('hex') !== snapshot.files[index].sha256)
      findings.push({ file, rule: 'snapshot-checksum-mismatch' });
    for (const issue of inspect(file, bytes)) findings.push({ file, ...issue });
  }
  return { files: files.length, findings };
}

if (require.main === module) {
  try {
    const report = check(path.resolve(__dirname, '..'));
    console.log(JSON.stringify(report, null, 2));
    console.log('Current tracked source only. Git history, PRs, releases, archives and image contents require separate review.');
    if (report.findings.length) process.exitCode = 1;
  } catch {
    console.error('Public source check could not read the complete tracked tree; check failed.');
    process.exitCode = 1;
  }
}
module.exports = { inspect, check };
