const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inspect } = require('../check-public-source.cjs');

test('private evidence, signing files, environment files and installable artifacts are rejected', () => {
  for (const file of ['verification/device/screen.png', 'experiments/phase2/results/probe.json',
    'artifacts/notes.txt', 'test-snapshots/tree.txt', '.codex-remote-attachments/input.png',
    'private/release.jks', 'public/app.apk', 'app/.env', '.env.production', '.gitleaks-baseline.json', 'android-app/.gitleaks-baseline.json',
    'android-app/apps/mobile/assets/config/google-services/google-services.json']) {
    assert.equal(inspect(file, Buffer.from('ordinary content'))[0]?.rule, 'private-or-built-artifact', file);
  }
  assert.deepEqual(inspect('docs/install.md', Buffer.from('Public guide')), []);
  assert.deepEqual(inspect('.env.example', Buffer.from('EXAMPLE=')), []);
});

test('credential detection reports locations without including credentials, including UTF-16 text', () => {
  const value = ['gh', 'p_', 'Z'.repeat(36)].join('');
  for (const bytes of [Buffer.from('note\n' + value), Buffer.from('\ufeffnote\n' + value, 'utf16le')]) {
    const findings = inspect('src/settings.txt', bytes);
    assert.deepEqual(findings, [{ rule: 'service-token', line: 2 }]);
    assert.ok(!JSON.stringify(findings).includes(value));
  }
  const privateKey = ['-----BEGIN ', 'OPENSSH ', 'PRIVATE KEY-----'].join('');
  assert.equal(inspect('fixture.txt', Buffer.from(privateKey))[0]?.rule, 'private-key');
  assert.deepEqual(inspect('public.pem', Buffer.from('-----BEGIN PUBLIC KEY-----')), []);
});

test('Sentry organization and user token prefixes are detected without disclosing their values', () => {
  for (const prefix of ['sntry' + 's_', 'sntry' + 'u_']) {
    const value = prefix + 'Z'.repeat(40);
    const findings = inspect('src/example.txt', Buffer.from('first line\n' + value));
    assert.deepEqual(findings, [{ rule: 'service-token', line: 2 }]);
    assert.ok(!JSON.stringify(findings).includes(value));
  }
});
