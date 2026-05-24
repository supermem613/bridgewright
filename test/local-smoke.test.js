const test = require('node:test');

const { runLocalSmoke } = require('../scripts/local-smoke.js');

test('local e2e verifies default and named profile navigation and cleanup', { timeout: 120000 }, async t => {
  await runLocalSmoke({}, {
    log(message) {
      t.diagnostic(message);
    },
  });
});
