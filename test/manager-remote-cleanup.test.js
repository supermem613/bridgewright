const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function withVscodeShim(deleteImpl, callback) {
  const originalLoad = Module._load;
  const shim = {
    StatusBarAlignment: { Left: 1 },
    window: {
      createStatusBarItem() {
        return {
          text: '',
          tooltip: '',
          command: undefined,
          show() {},
          dispose() {},
        };
      },
      createOutputChannel() {
        return {
          appendLine() {},
          show() {},
          dispose() {},
        };
      },
    },
    workspace: {
      getConfiguration(section) {
        assert.equal(section, 'bridgewright');
        return {
          get(_name, fallback) {
            return fallback;
          },
        };
      },
      fs: {
        delete: deleteImpl,
      },
    },
  };
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') {
      return shim;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('../dist/manager.js')];
  try {
    return callback(require('../dist/manager.js'));
  } finally {
    delete require.cache[require.resolve('../dist/manager.js')];
    Module._load = originalLoad;
  }
}

function createManager(BridgeManager) {
  return new BridgeManager({ subscriptions: [] });
}

test('remote runtime cleanup ignores VS Code nonexistent-file delete errors', async () => {
  await withVscodeShim(async () => {
    throw new Error("Unable to delete nonexistent file 'vscode-remote://codespaces+example/home/vscode/.bridgewright/runtime'");
  }, async ({ BridgeManager }) => {
    const manager = createManager(BridgeManager);
    await manager.deleteRemoteDirectoryIfExists({ toString: () => 'vscode-remote://codespaces+example/home/vscode/.bridgewright/runtime' });
  });
});

test('remote runtime cleanup still fails on real delete errors', async () => {
  await withVscodeShim(async () => {
    throw new Error('Permission denied deleting remote runtime');
  }, async ({ BridgeManager }) => {
    const manager = createManager(BridgeManager);
    await assert.rejects(
      manager.deleteRemoteDirectoryIfExists({ toString: () => 'vscode-remote://codespaces+example/home/vscode/.bridgewright/runtime' }),
      /Permission denied/,
    );
  });
});
