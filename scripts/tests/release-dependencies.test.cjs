const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

test('inventory retains transitive binaries and local files without resolving ambiguous project artifacts', () => {
  const gradle = process.env.MELO_TEST_GRADLE;
  assert.ok(gradle, 'Set MELO_TEST_GRADLE to a Gradle 9.3.1 executable or project wrapper');
  const temp = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, 'melo-inventory-'));
  try {
    const write = (file, text) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); };
    write('settings.gradle', "rootProject.name = 'inventory-fixture'\ninclude ':app', ':native'\n");
    write('native/build.gradle', '// Configured by the root fixture build.\n');
    write('buildSrc/build.gradle', "plugins { id 'java' }\n");
    write('buildSrc/src/main/java/FixtureAndroidPlugin.java', 'import org.gradle.api.Plugin; import org.gradle.api.Project; public class FixtureAndroidPlugin implements Plugin<Project> { public void apply(Project project) {} }');
    write('buildSrc/src/main/resources/META-INF/gradle-plugins/com.android.application.properties', 'implementation-class=FixtureAndroidPlugin\n');
    write('build.gradle', `allprojects { repositories { maven { url = rootProject.file('repo') } } }
project(':native') {
  def elements = configurations.create('releaseRuntimeElements') {
    canBeConsumed = true; canBeResolved = false
    attributes.attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage, Usage.JAVA_RUNTIME))
  }
  ['android-aar-metadata', 'android-classes-jar'].each { kind ->
    elements.outgoing.variants.create(kind) {
      attributes.attribute(Attribute.of('artifactType', String), kind)
      artifact(rootProject.file(kind + '.jar'))
    }
  }
  dependencies.add('releaseRuntimeElements', 'fixture:transitive:1.0')
}
project(':app') {
  apply plugin: 'com.android.application'
  configurations.create('releaseRuntimeClasspath') {
    canBeConsumed = false; canBeResolved = true
    attributes.attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage, Usage.JAVA_RUNTIME))
  }
  dependencies.add('releaseRuntimeClasspath', dependencies.project(path: ':native'))
  dependencies.add('releaseRuntimeClasspath', files('local.jar'))
}
`);
    write('repo/fixture/transitive/1.0/transitive-1.0.pom', '<project><modelVersion>4.0.0</modelVersion><groupId>fixture</groupId><artifactId>transitive</artifactId><version>1.0</version><packaging>jar</packaging></project>');
    write('repo/fixture/transitive/1.0/transitive-1.0.jar', 'external library fixture');
    write('app/local.jar', 'local replacement fixture');
    write('android-aar-metadata.jar', 'metadata fixture');
    write('android-classes-jar.jar', 'classes fixture');
    const init = path.resolve(__dirname, '../release-dependencies.init.gradle');
    const args = ['-p', root, ':app:meloReleaseDependencyInventory', '--init-script', init, '--offline', '--no-daemon', '--max-workers=2', '--console=plain'];
    const result = process.platform === 'win32'
      ? cp.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${path.resolve(gradle)}" ${args.map(value => '"' + value + '"').join(' ')}"`], { encoding: 'utf8', timeout: 180000, windowsVerbatimArguments: true, windowsHide: true })
      : cp.spawnSync('bash', [gradle, ...args], { encoding: 'utf8', timeout: 180000 });
    assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || '') + (result.error || ''));
    const report = fs.readFileSync(path.join(root, 'app/build/reports/melo-release-dependencies.json'), 'utf8');
    const parsed = JSON.parse(report);
    assert.deepEqual(parsed.localProjects, [':native']);
    assert.equal(parsed.artifacts.length, 2);
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    assert.equal(parsed.artifacts.find(item => item.coordinate === 'fixture:transitive:1.0').sha256, hash('external library fixture'));
    assert.equal(parsed.artifacts.find(item => item.coordinate === 'file:local.jar').sha256, hash('local replacement fixture'));
    assert.ok(!report.includes(root) && !report.includes(root.replaceAll('\\', '/')), 'report must not contain machine paths');
  } finally {
    assert.ok(path.resolve(root).startsWith(temp + path.sep));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
