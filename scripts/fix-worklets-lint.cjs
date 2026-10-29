// Verified phase-2 workaround: flatten applied Kotlin build scripts for lint K2.
// Keep lint enabled and leave runtime behavior unchanged. Refuse unknown layouts.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../android-app/apps/mobile/node_modules/react-native-worklets/android');
const file = path.join(root, 'build.gradle.kts');
let source = fs.readFileSync(file, 'utf8');
if (!source.includes('// MeloCanvas: inline applied scripts for lint K2')) {
  const prefab = fs.readFileSync(path.join(root, 'fix-prefab.gradle.kts'), 'utf8');
  const pch = fs.readFileSync(path.join(root, 'generate-stub-pch.gradle.kts'), 'utf8');
  const duplicate = prefab.slice(0, prefab.indexOf('tasks.configureEach'));
  const target = /apply\(from = "\.\/fix-prefab\.gradle\.kts"\)\r?\napply\(from = "\.\/generate-stub-pch\.gradle\.kts"\)/;
  if (!source.includes(duplicate.trim()) || !target.test(source)) throw new Error('Worklets build scripts changed; review compatibility patch.');
  const replacement = '// MeloCanvas: inline applied scripts for lint K2\n' + prefab.slice(prefab.indexOf('tasks.configureEach')) + '\n' + pch.replace(/^import groovy.json.JsonSlurper\r?\n/, '');
  source = source.replace(target, () => replacement);
  fs.writeFileSync(file, source);
}
