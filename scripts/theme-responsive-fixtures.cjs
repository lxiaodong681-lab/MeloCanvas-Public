// Build real author packages for responsive device checks; never installs or applies them.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const root = path.resolve(__dirname, '..');
const target = path.resolve(root, process.argv[2] || 'test-results/theme-responsive-fixtures');
if (fs.existsSync(target)) throw Error('Choose a fresh fixture output directory; existing evidence is preserved.');
const variants = [
  { key: 'policy48', name: '触控验收48', minTouchDp: 48, layout: { narrowFallback: 'reject' } },
  { key: 'regular49', name: '触控验收49', minTouchDp: 49, layout: { narrowFallback: 'reject' } },
  { key: 'compact96', name: '触控紧凑96', minTouchDp: 96, layout: { compactMinTouchDp: 48, narrowFallback: 'reject' } },
  { key: 'fallback96', name: '触控兼容96', minTouchDp: 96, layout: { compactMinTouchDp: 72, narrowFallback: 'host-single-row' } },
  { key: 'reject96', name: '触控拒绝96', minTouchDp: 96, layout: { narrowFallback: 'reject' } },
];
fs.mkdirSync(target, { recursive: true });
const reports = [];
for (const variant of variants) {
  const sourceRoot = path.join(target, variant.key);
  fs.cpSync(path.join(root, 'theme-packages/example'), sourceRoot, { recursive: true, errorOnExist: true, force: false });
  const sourcePath = path.join(sourceRoot, 'source.json');
  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  source.manifest.id = `verification.touch-${variant.key}`;
  source.manifest.name = variant.name;
  source.manifest.requiredCapabilities.push('responsive-touch-layout-v1');
  fs.writeFileSync(sourcePath, JSON.stringify(source, null, 2) + '\n');
  const componentsPath = path.join(sourceRoot, 'components.json');
  const components = JSON.parse(fs.readFileSync(componentsPath, 'utf8'));
  components.components.button.minTouchDp = variant.minTouchDp;
  components.components.layout = variant.layout;
  fs.writeFileSync(componentsPath, JSON.stringify(components, null, 2) + '\n');
  const archive = path.join(target, `${variant.key}.melotheme`);
  const result = JSON.parse(cp.execFileSync(process.execPath, [path.join(root, 'scripts/theme-package.cjs'), 'build', sourceRoot, archive], {
    cwd: root, encoding: 'utf8', timeout: 60000,
  }));
  reports.push({ ...variant, ...result, deviceStatus: 'not-run' });
}
const report = { sourceCommit: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), packages: reports };
fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
