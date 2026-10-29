// OkHttp stores UTF-8 sorted rules and exceptions, each preceded by a big-endian length.
function publicSuffixPayload(source) {
  const lines = source.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('//'));
  const encode = values => {
    const sorted = [...new Set(values)].map(s => Buffer.from(s)).sort(Buffer.compare);
    const bytes = Buffer.concat(sorted.flatMap(s => [s, Buffer.from('\n')]));
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); return Buffer.concat([size, bytes]);
  };
  return Buffer.concat([encode(lines.filter(l => !l.startsWith('!'))), encode(lines.filter(l => l.startsWith('!')).map(l => l.slice(1)))]);
}
module.exports = { publicSuffixPayload };
