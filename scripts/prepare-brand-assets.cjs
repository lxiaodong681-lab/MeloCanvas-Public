// Platform packaging only: preserve the supplied icon, add adaptive-mask safe space.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { loadSharp } = require('./lib/theme-package-node.cjs');
const root = path.resolve(__dirname, '..');
const mobile = path.join(root, 'android-app/apps/mobile');

async function main() {
  const sharp = loadSharp();
  const icon = path.join(mobile, 'melo/assets/icon.png');
  const foreground = path.join(mobile, 'melo/assets/icon-foreground.png');
  await sharp(icon).resize(676, 676).extend({ top: 174, bottom: 174, left: 174, right: 174, background: '#00000000' }).png().toFile(foreground);
  const mobileRequire = createRequire(path.join(mobile, 'package.json'));
  const expoRequire = createRequire(mobileRequire.resolve('expo/package.json'));
  const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
  const prebuildRequire = createRequire(cliRequire.resolve('@expo/prebuild-config/package.json'));
  const { setIconAsync } = prebuildRequire('./build/plugins/icons/withAndroidIcons.js');
  await setIconAsync(mobile, { icon, foregroundImage: foreground, backgroundColor: '#faf8f5', isAdaptive: true });
  require('../android-app/apps/mobile/expo-plugins/withMeloSplash').writeSplash(mobile, path.join(mobile, 'android'));
  // Replace the legacy native splash resources too, so no launcher path retains old branding.
  for (const [density, scale] of Object.entries({ mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 })) {
    const folder = path.join(mobile, `android/app/src/main/res/drawable-${density}`);
    fs.mkdirSync(folder, { recursive: true });
    await sharp(icon).resize(Math.round(96 * scale), Math.round(96 * scale)).png().toFile(path.join(folder, 'splashscreen_logo.png'));
  }
  console.log('Generated Android launcher and splash resources from the supplied MeloCanvas icon.');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
