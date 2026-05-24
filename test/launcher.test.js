const assert = require('node:assert/strict');
const test = require('node:test');

const { createRemoteLauncherScript, remoteShellQuote, resolveRemoteRuntimePath } = require('../dist/launcher.js');

test('remote shell quote preserves shell-sensitive path characters', () => {
  assert.equal(
    remoteShellQuote('/workspaces/O\'Brien/$HOME/`edge`/"profile"!'),
    '\'/workspaces/O\'\\\'\'Brien/$HOME/`edge`/"profile"!\'',
  );
});

test('remote launcher script invokes helper with stable argv and diagnostics', () => {
  const script = createRemoteLauncherScript({
    helperPath: '/home/vscode/.bridgewright/runtime/bridgewright-helper.cjs',
    readyPath: '/home/vscode/.bridgewright/runtime/ready-1.json',
    logPath: '/home/vscode/.bridgewright/runtime/helper-1.log',
    cdpPort: 37373,
    tunnelPort: 37374,
  });

  assert.match(script, /^#!\/usr\/bin\/env sh\nset -eu\n/);
  assert.match(script, /log_dir=\$\(dirname "\$log"\)\nmkdir -p "\$log_dir"\n: >> "\$log"/);
  assert.match(script, /command -v node \|\| true/);
  assert.match(script, /exec node \\/);
  assert.match(script, /--replace-existing \\/);
  assert.match(script, /--cdp-port \\\n    37373 \\/);
  assert.match(script, /--tunnel-port \\\n    37374 \\/);
  assert.match(script, /--ready-file \\/);
  assert.match(script, /--runtime-log \\/);
  assert.match(script, /--connector-timeout-ms \\\n    3000 \\/);
  assert.match(script, /--discovery-timeout-ms \\\n    20000/);
  assert.match(script, /\} >> "\$log" 2>&1\n$/);
  assert.doesNotMatch(script, /[A-Za-z]:\\/);
  assert.doesNotMatch(script, /\\workspaces/);
});

test('remote runtime path stays in the remote user home for home-based workspaces', () => {
  assert.equal(
    resolveRemoteRuntimePath('/home/vscode/repos/kash'),
    '/home/vscode/.bridgewright/runtime',
  );
  assert.equal(
    resolveRemoteRuntimePath('/home/marcusm/work/bridgewright/'),
    '/home/marcusm/.bridgewright/runtime',
  );
});

test('remote runtime path falls back to Codespaces home for workspaces outside home', () => {
  assert.equal(
    resolveRemoteRuntimePath('/workspaces/bridgewright'),
    '/home/vscode/.bridgewright/runtime',
  );
});
