const test = require('node:test');

const { runLocalSmoke, runLockedDefaultProfileProbe } = require('../scripts/local-smoke.js');

test('local e2e returns a prompt root discovery error when default profile is locked', { timeout: 30000 }, async t => {
  await runLockedDefaultProfileProbe({
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
