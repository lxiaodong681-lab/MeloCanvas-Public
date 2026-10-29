const fs = require('node:fs');
const path = require('node:path');
const { mobileRequire } = require('./theme-package-node.cjs');
// Only the repository's original examples are MIT. User-imported art is never relicensed.
async function licenseExample(bytes) {
  const zip = await mobileRequire('jszip').loadAsync(bytes, { checkCRC32: true });
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  manifest.author = 'MeloCanvas';
  manifest.license = 'MIT';
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('LICENSE.txt', fs.readFileSync(path.resolve(__dirname, '../../LICENSE'), 'utf8').replaceAll('\r\n', '\n'));
  for (const entry of Object.values(zip.files)) entry.date = new Date('2000-01-01T00:00:00Z');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
module.exports = { licenseExample };
