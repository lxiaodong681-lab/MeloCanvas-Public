// Reproducible project-owned replacements; no upstream image or animation input.
const fs = require('node:fs');
const path = require('node:path');
const { crc32, deflateSync } = require('node:zlib');
const { loadSharp } = require('./lib/theme-package-node.cjs');
const root = path.resolve(__dirname, '..');
const mobile = 'android-app/apps/mobile/';
const checking = process.argv.includes('--check');
function write(file, bytes) {
  const target = path.join(root, file);
  if (checking) {
    if (!fs.readFileSync(target).equals(bytes)) throw new Error(`Generated asset differs: ${file}`);
  } else fs.writeFileSync(target, bytes);
}
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}
const polygon = vertices => ({ ty: 'sh', ks: { a: 0, k: { i: vertices.map(() => [0, 0]), o: vertices.map(() => [0, 0]), v: vertices, c: true } } });
const fill = { ty: 'fl', c: { a: 0, k: [1, 1, 1, 1] }, o: { a: 0, k: 100 }, r: 1 };
function layer(name, shapes, opacity = { a: 0, k: 100 }) {
  return { ddd: 0, ind: name === 'play' ? 2 : 1, ty: 4, nm: name, sr: 1,
    ks: { o: opacity, r: { a: 0, k: 0 }, p: { a: 0, k: [0, 0, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } },
    shapes: [...shapes.map(polygon), fill], ip: 0, op: 61, st: 0, bm: 0 };
}
function animations() {
  const triangle = [[9, 7], [24, 16], [9, 25]], bars = [[[8, 7], [13, 7], [13, 25], [8, 25]], [[19, 7], [24, 7], [24, 25], [19, 25]]];
  const opacity = (start, end) => ({ a: 1, k: [{ t: 0, s: [start], e: [end], o: { x: [0.33], y: [0] }, i: { x: [0.67], y: [1] } }, { t: 8, s: [end] }] });
  const base = { v: '5.6.5', fr: 30, ip: 0, op: 61, w: 32, h: 32, ddd: 0, assets: [] };
  const result = { 'play-pause': { ...base, nm: 'MeloCanvas geometric pause-to-play', layers: [layer('pause', bars, opacity(100, 0)), layer('play', [triangle], opacity(0, 100))] } };
  for (const [name, mirror] of [['skip-next', false], ['skip-prev', true]]) {
    const points = [[[8, 7], [21, 16], [8, 25]], [[22, 7], [25, 7], [25, 25], [22, 25]]].map(shape => shape.map(([x, y]) => [mirror ? 32 - x : x, y]));
    result[name] = { ...base, nm: `MeloCanvas geometric ${name}`, layers: [layer(name, points)] };
  }
  return result;
}
async function main() {
  const sharp = loadSharp(), icon = path.join(root, mobile, 'melo/assets/icon.png');
  const icons = [
    ...[[120, ''], [180, '@1,5x'], [240, '@2x'], [360, '@3x'], [480, '@4x']].map(([size, suffix]) => [mobile + `assets/bootsplash/logo${suffix}.png`, size]),
    ...[['adaptive-icon', 1025], ['icon_large', 512], ['icon', 1025], ['splash-icon', 1024]].map(([name, size]) => [mobile + `assets/images/${name}.png`, size]),
    ['android-app/apps/update-server/web/public/icon.png', 1025],
  ];
  for (const [file, size] of icons) write(file, await sharp(icon).resize(size, size).png().toBuffer());
  write(mobile + 'assets/images/bilibili-default-avatar.jpg', await sharp(path.join(root, 'design-prototype/assets/fallback-avatar.svg')).jpeg({ quality: 95 }).toBuffer());
  write(mobile + 'assets/images/media3_notification_small_icon.png', await sharp(path.join(root, 'design-prototype/assets/notification-note.svg')).png().toBuffer());
  for (const [name, animation] of Object.entries(animations())) write(mobile + `src/assets/lottie/${name}.json`, Buffer.from(JSON.stringify(animation, null, '\t') + '\n'));
  const pixels = Buffer.alloc(9 * 9 * 4);
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) pixels.set((x + y) % 2 ? [90, 150, 210, 255] : [210, 110, 80, 170], (y * 9 + x) * 4);
  const make = () => sharp(pixels, { raw: { width: 9, height: 9, channels: 4 } });
  const fixtures = 'android-app/packages/native/android/src/test/resources/';
  write(fixtures + 'theme-palette.png', await make().png({ palette: true }).toBuffer());
  write(fixtures + 'theme-adam7.png', await make().png({ progressive: true }).toBuffer());
  const rgba = await make().withIccProfile('srgb').png().toBuffer();
  const profile = (await sharp(rgba).metadata()).icc;
  // Sharp's bundled compact sRGB profile identifies its copyright as CC0.
  if (!profile || !profile.includes(Buffer.from([0, 67, 0, 67, 0, 48]))) throw new Error('Review changed sRGB profile copyright before regeneration');
  const extra = Buffer.concat([
    pngChunk('zTXt', Buffer.concat([Buffer.from('Author\0\0'), deflateSync(Buffer.from('MeloCanvas synthetic decoder fixture'))])),
    pngChunk('iTXt', Buffer.concat([Buffer.from('Comment\0\x01\0\0\0'), deflateSync(Buffer.from('合成解码夹具'))])),
  ]);
  write(fixtures + 'theme-rgba-icc-text.png', Buffer.concat([rgba.subarray(0, 33), extra, rgba.subarray(33)]));
  console.log(`${checking ? 'Verified' : 'Generated'} 18 replacement assets; MIT project geometry and icon, CC0 embedded sRGB profile.`);
}
module.exports = { animations };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
