// Independent real PNG fixtures for the external Android decoder check.
const fs = require('node:fs');
const path = require('node:path');
const { crc32, deflateSync } = require('node:zlib');
const { loadSharp } = require('./lib/theme-package-node.cjs');
const out = path.resolve(process.argv[2] || '');
if (!process.argv[2] || fs.existsSync(out)) throw new Error('Specify a new fixture directory');
fs.mkdirSync(out, { recursive: true });
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function chunks(png) {
  const result = [];
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at);
    result.push({ type: png.toString('ascii', at + 4, at + 8), data: png.subarray(at + 8, at + 8 + size) });
    at += size + 12;
  }
  return result;
}
const pack = (entries) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...entries.map(({ type, data }) => chunk(type, data))]);
async function main() {
  const sharp = loadSharp();
  const make = (width, height) => sharp({ create: { width, height, channels: 4, background: { r: 90, g: 70, b: 160, alpha: 0.75 } } });
  const rgba = await make(17, 13).png().toBuffer();
  const cases = [];
  function add(name, bytes, expect, width = 17, height = 13, limits) {
    const file = `${name}.png`;
    fs.writeFileSync(path.join(out, file), bytes, { flag: 'wx' });
    cases.push({ name, file, expect, width, height, ...(limits ? { limits } : {}) });
  }
  add('rgba', rgba, 'ok');
  add('palette', await make(17, 13).png({ palette: true }).toBuffer(), 'ok');
  add('adam7', await make(17, 13).png({ progressive: true }).toBuffer(), 'ok');
  add('srgb-profile', await make(17, 13).withIccProfile('srgb').png().toBuffer(), 'ok');
  const indexedHeader = Buffer.alloc(13);
  indexedHeader.writeUInt32BE(1, 0); indexedHeader.writeUInt32BE(1, 4);
  indexedHeader[8] = 8; indexedHeader[9] = 3;
  const indexed = (index) => pack([
    { type: 'IHDR', data: indexedHeader }, { type: 'PLTE', data: Buffer.from([220, 60, 90]) },
    { type: 'IDAT', data: deflateSync(Buffer.from([0, index])) }, { type: 'IEND', data: Buffer.alloc(0) },
  ]);
  add('valid-short-palette', indexed(0), 'ok', 1, 1);
  add('out-of-range-palette-index', indexed(1), 'invalid', 1, 1);
  const base = chunks(rgba);
  function dataPng(compressed) {
    return pack([...base.filter((c) => !['IDAT', 'IEND'].includes(c.type)), { type: 'IDAT', data: compressed }, { type: 'IEND', data: Buffer.alloc(0) }]);
  }
  const compressed = Buffer.concat(base.filter((c) => c.type === 'IDAT').map((c) => c.data));
  add('truncated-zlib-valid-crc', dataPng(compressed.subarray(0, -3)), 'invalid');
  const damaged = Buffer.from(compressed); damaged[damaged.length - 1] ^= 1;
  add('bad-adler-valid-crc', dataPng(damaged), 'invalid');
  add('trailing-zlib', dataPng(Buffer.concat([compressed, Buffer.from([0])])), 'invalid');
  add('short-scanlines', dataPng(deflateSync(Buffer.alloc((17 * 4 + 1) * 13 - 1))), 'invalid');
  add('extra-scanlines', dataPng(deflateSync(Buffer.alloc((17 * 4 + 1) * 13 + 1))), 'invalid');
  add('truncated-container', rgba.subarray(0, -1), 'invalid');
  add('animated', pack([base[0], { type: 'acTL', data: Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]) }, ...base.slice(1)]), 'invalid');
  const largeHeader = Buffer.from(base[0].data); largeHeader.writeUInt32BE(8193, 0);
  add('oversize-header', pack([{ type: 'IHDR', data: largeHeader }, ...base.slice(1)]), 'limit');
  add('metadata-bomb', pack([base[0], { type: 'zTXt', data: Buffer.concat([Buffer.from('author\0\0'), deflateSync(Buffer.alloc(1024 * 1024 + 1, 65))]) }, ...base.slice(1)]), 'limit');
  add('tight-output-budget', rgba, 'limit', 17, 13, [8388608, 8000000, 8192, 17 * 13 * 4 - 1]);
  add('tight-input-budget', rgba, 'limit', 17, 13, [rgba.length - 1, 8000000, 8192, 33554432]);
  add('eight-million-pixels', await make(4000, 2000).png().toBuffer(), 'ok', 4000, 2000);
  fs.writeFileSync(path.join(out, 'cases.json'), JSON.stringify(cases, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ directory: out, cases: cases.length }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
