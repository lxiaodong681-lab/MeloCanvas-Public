// Reproducible author fixture for package icons; never installs or applies it.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const target = path.resolve(root, process.argv[2] || 'test-results/theme-icon-fixture');
if (fs.existsSync(target)) throw Error('Choose a fresh output directory to preserve existing evidence.');
const sourceRoot = path.join(target, 'source');
fs.cpSync(path.join(root, 'theme-packages/example'), sourceRoot, { recursive: true, errorOnExist: true, force: false });
const read = (name) => JSON.parse(fs.readFileSync(path.join(sourceRoot, name), 'utf8'));
const write = (name, value) => fs.writeFileSync(path.join(sourceRoot, name), JSON.stringify(value, null, 2) + '\n');
const source = read('source.json');
const components = read('components.json');
source.manifest.id = 'verification.paper-icons';
source.manifest.name = '纸间图标验收';
source.manifest.requiredCapabilities.push('package-icons-v1');
// Keep the old 48dp layout independent of responsive-touch-layout-v1.
components.components.button.minTouchDp = 48;
const shapes = {
  flower: '<circle cx="32" cy="32" r="8"/><path d="M32 22C14 3 7 23 22 32C3 50 23 57 32 42C50 61 57 41 42 32C61 14 41 7 32 22Z"/>',
  search: '<circle cx="27" cy="27" r="14"/><path d="M38 38L52 52"/>',
  library: '<path d="M16 15V49M27 15V49M38 17L47 15L53 47L44 49Z"/>',
  user: '<circle cx="32" cy="23" r="10"/><path d="M15 51V46C15 30 49 30 49 46V51"/>',
  heart: '<path d="M32 51L12 32C-1 15 21 4 32 20C43 4 65 15 52 32Z"/>',
  play: '<path d="M24 16L49 32L24 48Z"/>',
};
components.components.icons = {};
for (const [name, geometry] of Object.entries(shapes)) {
  const states = {};
  for (const selected of [false, true]) {
    // Play has no selected asset, exercising the normal-art fallback contract.
    if (name === 'play' && selected) continue;
    const state = selected ? 'selected' : 'normal';
    const file = `icon-${name}-${state}`;
    const background = selected ? '#d3e7db' : '#fffdf7';
    const stroke = selected ? '#174d3d' : '#52665f';
    const fill = name === 'play' || (name === 'heart' && selected) ? stroke : 'none';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="16" fill="${background}"/><g fill="${fill}" stroke="${stroke}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">${geometry}</g></svg>\n`;
    fs.writeFileSync(path.join(sourceRoot, 'artwork', `${file}.svg`), svg);
    const asset = `assets/${file}.png`;
    source.images[asset] = `artwork/${file}.svg`;
    states[state] = asset;
  }
  components.components.icons[name] = { light: states };
}
write('source.json', source);
write('components.json', components);
const archive = path.join(target, 'paper-icons.melotheme');
const result = JSON.parse(cp.execFileSync(process.execPath, [path.join(root, 'scripts/theme-package.cjs'), 'build', sourceRoot, archive], {
  cwd: root, encoding: 'utf8', timeout: 60000,
}));
const report = {
  sourceCommit: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  generatorSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  semantics: Object.keys(shapes),
  iconAssets: Object.keys(source.images).filter((name) => name.startsWith('assets/icon-')).length,
  ...result,
  previewNote: 'Bundled paper-signal static previews do not demonstrate the new icon renderer.',
  deviceStatus: 'not-run',
};
fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
