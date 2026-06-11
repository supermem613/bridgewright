const test = require('node:test');

const {
  runIsolatedDefaultProfileProbe,
  runLocalSmoke,
  runLockedDefaultProfileProbe,
  runSystemDefaultProfileCompatibilityProbe,
} = require('../scripts/local-smoke.js');

test('local e2e returns a prompt root discovery error when default profile is locked', { timeout: 30000 }, async t => {
  await runLockedDefaultProfileProbe({
    log(message) {
      t.diagnostic(message);
    },
  });
});

test('local e2e uses isolated default profile when system Edge profile is locked', { timeout: 60000 }, async t => {
  await runIsolatedDefaultProfileProbe({
    log(message) {
      t.diagnostic(message);
    },
  });
});

test('local e2e uses system Edge profile only when compatibility switch is enabled', { timeout: 30000 }, async t => {
  await runSystemDefaultProfileCompatibilityProbe({
    log(message) {
      t.diagnostic(message);
    },
  });
});

test('local e2e verifies default and named profile navigation and cleanup', { timeout: 120000 }, async t => {
  await runLocalSmoke({}, {
    log(message) {
      t.diagnostic(message);
    },
  });
});
