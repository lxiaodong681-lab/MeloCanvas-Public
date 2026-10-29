// Node-only byte/depth measurements. Returns no playlist/track/user values.
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const omit = (value, names) => Object.fromEntries(Object.entries(value).filter(([key]) => !names.includes(key)));
function depth(value) {
  let max = 0, nonFiniteValues = 0;
  const stack = [[value, 0]];
  while (stack.length) {
    const [item, level] = stack.pop(); max = Math.max(max, level);
    if (typeof item === 'number' && !Number.isFinite(item)) nonFiniteValues++;
    if (item && typeof item === 'object') for (const child of Object.values(item)) stack.push([child, level + 1]);
  }
  return { maxDepth: max, nonFiniteValues };
}
const measure = (value) => ({ utf8Bytes: bytes(value), ...depth(value) });
function fields(value) {
  return Object.entries(value).map(([key, item]) => ({ field: /^[A-Za-z0-9_-]{1,64}$/.test(key) ? key : '[non-schema-key]', ...measure(item) }))
    .sort((a, b) => b.utf8Bytes - a.utf8Bytes);
}
function distribution(values, byteLimit, depthLimit) {
  const measured = values.map(measure);
  return { count: measured.length, maxUtf8Bytes: Math.max(0, ...measured.map((item) => item.utf8Bytes)),
    totalUtf8Bytes: measured.reduce((sum, item) => sum + item.utf8Bytes, 0),
    overByteLimitCount: measured.filter((item) => item.utf8Bytes > byteLimit).length,
    maxDepth: Math.max(0, ...measured.map((item) => item.maxDepth)),
    overDepthLimitCount: measured.filter((item) => item.maxDepth > depthLimit).length };
}
function measureNeteaseDirectory(body) {
  if (!object(body) || !object(body.playlist)) throw new Error('No object playlist for byte statistics');
  const envelope = omit(body, ['playlist']), playlist = omit(body.playlist, ['tracks', 'trackIds']);
  const tracks = body.playlist.tracks, ids = body.playlist.trackIds;
  if (!Array.isArray(tracks) || !Array.isArray(ids) || tracks.length > 5000 || ids.length > 5000) throw new Error('Missing/oversized arrays for bounded byte statistics');
  const indexIdentityAgreement = tracks.length === ids.length && tracks.every((track, index) => object(track) && object(ids[index]) && String(track.id) === String(ids[index].id));
  const result = { budgets: { playlistMetadataBytes: 65536, entryMetadataBytes: 16384, metadataDepth: 8 },
    entireJson: measure(body), envelopeWithoutPlaylist: { ...measure(envelope), fields: fields(envelope) },
    playlistWithoutLists: { ...measure(playlist), fields: fields(playlist) },
    // Actual metadata also includes directory reconciliation; this strict lower bound alone can prove overflow.
    combinedDirectoryMetadataLowerBound: measure({ playlist, envelope }),
    rawTracks: distribution(tracks, 16384, 8), rawDirectoryItems: distribution(ids, 16384, 8), indexIdentityAgreement };
  if (indexIdentityAgreement) result.entryMetadata = distribution(tracks.map((track, index) => ({ track, directoryItem: ids[index], returnedPosition: index, metadataStatus: 'read' })), 16384, 8);
  return result;
}
module.exports = { measureNeteaseDirectory };
