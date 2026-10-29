// Collect evidence from the actual Metro source map, not the workspace's dev dependencies.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const mobile = path.join(root, 'android-app/apps/mobile');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function inside(base, file) { const relative = path.relative(base, file); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
function sourceList(map) {
  return [...(map.sources || []).map(s => ({ source: s, sourceRoot: map.sourceRoot || '' })), ...(map.sections || []).flatMap(s => sourceList(s.map))];
}
function packageFor(file, boundary) {
  let dir = path.dirname(fs.realpathSync(file));
  while (inside(boundary, dir)) {
    const manifest = path.join(dir, 'package.json');
    // Some package subdirectories use an anonymous {"type":"module"} manifest.
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest));
      if (typeof pkg.name === 'string' && (typeof pkg.version === 'string' || !dir.split(path.sep).includes('node_modules'))) return dir;
    }
    const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
  }
  return null;
}
function noticeFiles(dir) {
  const result = [];
  const visit = current => {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      if (e.isSymbolicLink() || ['node_modules', '.git', 'build', '.gradle'].includes(e.name)) continue;
      const file = path.join(current, e.name);
      if (e.isDirectory()) visit(file);
      else if (/^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$|third.party.*(?:licen[cs]e|notice)/i.test(e.name)) result.push(file);
    }
  };
  visit(dir); return result.sort();
}
function collect(mapFile, out, boundary = root, app = mobile, serverRoot = app) {
  const sources = sourceList(JSON.parse(fs.readFileSync(mapFile)));
  if (!sources.length) throw new Error('Metro source map has no sources');
  const packages = new Map(); let unresolvedSources = 0, projectSources = 0;
  const generatedSources = [];
  const normalizedBoundary = fs.realpathSync(boundary);
  for (const { source, sourceRoot } of sources) {
    // These exact Metro/Expo-generated modules have no corresponding source file.
    // Do not silently accept other virtual sources: new generators require review.
    if (!sourceRoot && ['__prelude__', '\0polyfill:external-require', '\0polyfill:environment-variables', '\0polyfill:assets-registry'].includes(source)) {
      generatedSources.push(source.replace('\0', '')); continue;
    }
    const paths = [app, boundary, path.dirname(mapFile)].map(base => path.resolve(base, sourceRoot, source));
    // Expo's release serializer emits /<path relative to Metro serverRoot>,
    // deliberately hiding machine paths. In this monorepo serverRoot is android-app,
    // not apps/mobile. Keep absolute-file support and reject ambiguous resolution.
    if (!sourceRoot && source.startsWith('/') && !source.startsWith('//')) {
      const virtual = path.resolve(serverRoot, source.slice(1));
      if (inside(serverRoot, virtual)) paths.push(virtual);
    }
    const candidates = [...new Set(paths.filter(file => fs.existsSync(file) && fs.statSync(file).isFile()).map(file => fs.realpathSync(file)))];
    if (candidates.length !== 1 || !inside(normalizedBoundary, candidates[0])) { unresolvedSources++; continue; }
    const dir = packageFor(candidates[0], normalizedBoundary);
    if (!dir) { projectSources++; continue; }
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
    const external = dir.split(path.sep).includes('node_modules');
    const key = `${pkg.name}@${pkg.version || 'workspace'}`;
    if (!packages.has(key)) packages.set(key, { dir, name: pkg.name, version: pkg.version || null, declaredLicense: pkg.license || null, scope: external ? 'bundled-npm-code' : 'bundled-project-code', sourceCount: 0 });
    packages.get(key).sourceCount++;
  }
  fs.mkdirSync(out, { recursive: true });
  const entries = [];
  for (const p of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const { dir, ...record } = p; record.notices = [];
    // Project licensing is already maintained separately. Do not traverse the repository or sibling workspaces.
    for (const file of p.scope === 'bundled-npm-code' ? noticeFiles(dir) : []) {
      const bytes = fs.readFileSync(file), relative = path.relative(dir, file).split(path.sep).join('/');
      const output = `npm-notices/${p.name.replaceAll('/', '_')}@${p.version}/${relative}`;
      const target = path.join(out, output); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
      record.notices.push({ path: relative, evidenceFile: output, sha256: sha(bytes) });
    }
    entries.push(record);
  }
  const report = { status: unresolvedSources ? 'INCOMPLETE_SOURCE_RESOLUTION' : 'EVIDENCE_ONLY_REQUIRES_REVIEW', sourceMapSha256: sha(fs.readFileSync(mapFile)), totalSources: sources.length, unresolvedSources, projectSources, generatedSources, scope: 'Actual Metro source-map packages only; known Metro/Expo-generated modules are listed separately. Native-only modules and bundled native dependencies require separate review. No machine paths or source-map contents are retained here.', packages: entries };
  fs.writeFileSync(path.join(out, 'bundle-license-evidence.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
function assertComplete(report) {
  if (report.unresolvedSources || !report.packages.some(p => p.scope === 'bundled-npm-code')) {
    throw new Error(`Incomplete Metro license coverage: ${report.unresolvedSources}/${report.totalSources} unresolved sources, ${report.packages.length} packages`);
  }
}
module.exports = { collect, inside, sourceList, assertComplete };
if (require.main === module) {
  const config = require(path.join(mobile, 'metro.config.js'));
  const report = collect(path.join(mobile, 'android/app/build/generated/sourcemaps/react/release/index.android.bundle.map'), path.join(root, 'verification/android-ci/dependencies'), root, mobile, config.server?.unstable_serverRoot || config.projectRoot);
  console.log(JSON.stringify({ packages: report.packages.length, totalSources: report.totalSources, unresolvedSources: report.unresolvedSources }));
  assertComplete(report);
}
