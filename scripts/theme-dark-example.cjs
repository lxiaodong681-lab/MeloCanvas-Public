// Reproducible dual-mode author example, using host colors and original static art.
const fs = require('node:fs');
const path = require('node:path');
const { mobileRequire } = require('./lib/theme-package-node.cjs');
mobileRequire('tsx/cjs');
const { cosmosTheme } = require('../android-app/apps/mobile/melo/core/theme-appearance.ts');
const { builtInThemes } = require('../android-app/apps/mobile/melo/core/theme.ts');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'theme-packages/cosmos-example');
fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
const tokens = (theme, progress) => ({ ...theme.tokens, lyric: { active: theme.tokens.action.primary, inactive: theme.tokens.text.secondary }, progress });
const lightTheme = { ...builtInThemes.modern, tokens: { ...builtInThemes.modern.tokens, action: { primary: '#B83D32' } } };
const source = {
  manifest: {
    format: 'melocanvas-theme', schemaVersion: 1, id: 'example.cosmos-dual', version: '1.0.0',
    name: '宇宙 · 明暗样例', author: 'MeloCanvas', minAppVersion: '0.18.0', license: 'MIT',
    entry: { tokens: 'tokens.json', components: 'components.json' }, fallback: 'melocanvas.builtin.modern',
    requiredCapabilities: ['semantic-colors', 'dark-tokens', 'icons', 'backgrounds', 'component-variants', 'player-frame', 'motion-presets', 'custom-progress-v1'],
    optionalCapabilities: [], previews: ['previews/cosmos.png'],
  },
  images: { 'assets/cosmos.png': 'assets/cosmos.png', 'previews/cosmos.png': 'assets/cosmos.png' },
};
const components = {
  components: {
    card: { variant: 'rounded' }, button: { variant: 'rounded', minTouchDp: 48 }, input: { variant: 'rounded' },
    navigation: { discoverIcon: 'star' }, player: { frame: 'square' }, progress: { variant: 'modern' },
  },
  decorations: { hero: 'assets/cosmos.png' }, motion: { durationMs: 0, respectReducedMotion: true },
};
for (const [file, data] of Object.entries({
  'source.json': source,
  'tokens.json': { light: tokens(lightTheme, { track: '#DDD8D1', fill: '#C3483B', thumb: '#315A86' }), dark: tokens(cosmosTheme, { track: '#666674', fill: '#B9B5F5', thumb: '#E8E8ED' }) },
  'components.json': components,
})) fs.writeFileSync(path.join(output, file), JSON.stringify(data, null, 2) + '\n');
fs.copyFileSync(path.join(root, 'android-app/apps/mobile/melo/assets/cosmos.png'), path.join(output, 'assets/cosmos.png'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE.txt'));
console.log('Generated theme-packages/cosmos-example. Build with scripts/theme-package.cjs.');
