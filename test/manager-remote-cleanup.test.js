const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function withVscodeShim(deleteImpl, callback) {
  const originalLoad = Module._load;
  const outputLines = [];
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
          appendLine(line) {
            outputLines.push(line);
          },
          show() {},
          dispose() {},
        };
      },
      showInformationMessage() {
        return Promise.resolve(undefined);
      },
      showWarningMessage() {
        return Promise.resolve(undefined);
      },
      showErrorMessage() {
        return Promise.resolve(undefined);
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
    env: {
      remoteName: undefined,
      clipboard: {
        writeText() {
          return Promise.resolve(undefined);
        },
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
    return callback(require('../dist/manager.js'), outputLines);
  } finally {
    delete require.cache[require.resolve('../dist/manager.js')];
    Module._load = originalLoad;
  }
}

function createManager(BridgeManager) {
  return new BridgeManager({
    subscriptions: [],
    extension: {
      packageJSON: {
        version: '0.2.1',
      },
    },
  });
}

function createCdpVersionServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      if (request.url === '/json/version') {
        const body = JSON.stringify({
          Browser: 'Edg/test',
          webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/test`,
        });
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        });
        response.end(body);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function createCdpBrowserCloseServer() {
  return new Promise((resolve, reject) => {
    let closeRequested = false;
    const server = http.createServer((request, response) => {
      if (request.url === '/json/version') {
        const body = JSON.stringify({
          Browser: 'Edg/test',
          webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/test`,
        });
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        });
        response.end(body);
        return;
      }
      if (request.url === '/json/close') {
        closeRequested = true;
        response.writeHead(200);
        response.end('Target is closing');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      get closeRequested() {
        return closeRequested;
      },
    }));
  });
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

test('startup log includes Bridgewright package version', async () => {
  await withVscodeShim(async () => {}, async ({ BridgeManager }, outputLines) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridgewright-start-log-'));
    const manager = createManager(BridgeManager);
    manager.rootPath = path.join(root, 'state');
    manager.profilePath = path.join(root, 'profile');
    manager.logsPath = path.join(manager.rootPath, 'logs');
    manager.namedProfilesPath = path.join(manager.rootPath, 'profiles');
    manager.statePath = path.join(manager.rootPath, 'state.json');

    try {
      await manager.start();
      assert.ok(outputLines.some(line => /Starting Bridgewright bridge v0\.2\.1$/.test(line)));
    } finally {
      await manager.stopProcesses();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});

test('launch reuses existing Bridgewright debug Edge when DevToolsActivePort is healthy', async () => {
  await withVscodeShim(async () => {}, async ({ BridgeManager }) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridgewright-reuse-cdp-'));
    const profilePath = path.join(root, 'profile');
    const server = await createCdpVersionServer();
    const port = server.address().port;
    const manager = createManager(BridgeManager);

    try {
      await fs.promises.mkdir(profilePath, { recursive: true });
      await fs.promises.writeFile(path.join(profilePath, 'DevToolsActivePort'), `${port}\n/devtools/browser/test`, 'utf8');
      const launched = await manager.launchEdge('C:\\Windows\\System32\\where.exe', profilePath);
      assert.equal(launched.port, port);
      assert.equal(launched.cdp.Browser, 'Edg/test');
      assert.equal(launched.process, undefined);
      assert.equal(await fs.promises.readFile(path.join(profilePath, 'DevToolsActivePort'), 'utf8'), `${port}\n/devtools/browser/test`);
    } finally {
      server.close();
      await manager.stopProcesses();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});

test('launch recovers existing Bridgewright debug Edge port when profile owner is still running', async () => {
  await withVscodeShim(async () => {}, async ({ BridgeManager }) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridgewright-recover-cdp-'));
    const profilePath = path.join(root, 'profile');
    const server = await createCdpVersionServer();
    const port = server.address().port;
    const manager = createManager(BridgeManager);
    const originalExecFile = childProcess.execFile;
    let queried = false;

    childProcess.execFile = function execFile(file, args, options, callback) {
      queried = true;
      assert.equal(file, 'powershell.exe');
      assert.ok(args.includes('-OutputFormat'));
      assert.ok(args.includes('Text'));
      assert.ok(args.includes('-EncodedCommand'));
      const encodedCommand = args[args.indexOf('-EncodedCommand') + 1];
      const script = Buffer.from(encodedCommand, 'base64').toString('utf16le');
      assert.match(script, new RegExp(`\\$profile = '${profilePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
      callback(null, `${JSON.stringify([port])}\n`, '');
      return { once() {} };
    };

    try {
      await fs.promises.mkdir(profilePath, { recursive: true });
      await fs.promises.writeFile(path.join(profilePath, 'lockfile'), 'locked', 'utf8');
      const launched = await manager.launchEdge('C:\\Windows\\System32\\where.exe', profilePath);
      assert.equal(queried, true);
      assert.equal(launched.port, port);
      assert.equal(launched.cdp.Browser, 'Edg/test');
      assert.equal(launched.process, undefined);
      assert.equal(fs.existsSync(path.join(profilePath, 'DevToolsActivePort')), false);
    } finally {
      childProcess.execFile = originalExecFile;
      server.close();
      await manager.stopProcesses();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});

test('launch waits for DevToolsActivePort after clean Edge handoff exit', async () => {
  await withVscodeShim(async () => {}, async ({ BridgeManager }) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridgewright-edge-handoff-'));
    const profilePath = path.join(root, 'profile');
    const server = await createCdpVersionServer();
    const port = server.address().port;
    const manager = createManager(BridgeManager);
    const originalSpawn = childProcess.spawn;
    let writePortTimer;

    childProcess.spawn = function spawn() {
      const child = {
        exitCode: null,
        signalCode: null,
        killed: false,
        once(event, callback) {
          if (event === 'exit') {
            setTimeout(() => {
              child.exitCode = 0;
              callback(0, null);
            }, 10);
          }
          return child;
        },
        kill() {
          child.killed = true;
        },
      };
      return child;
    };
    manager.tryRecoverExistingEdgeCdp = async () => undefined;

    try {
      await fs.promises.mkdir(profilePath, { recursive: true });
      writePortTimer = setTimeout(() => {
        fs.writeFileSync(path.join(profilePath, 'DevToolsActivePort'), `${port}\n/devtools/browser/test`, 'utf8');
      }, 500);

      const launched = await manager.launchEdge('C:\\Windows\\System32\\where.exe', profilePath);

      assert.equal(launched.port, port);
      assert.equal(launched.cdp.Browser, 'Edg/test');
    } finally {
      clearTimeout(writePortTimer);
      childProcess.spawn = originalSpawn;
      server.close();
      await manager.stopProcesses();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});

test('stop runtime closes handoff Edge over CDP when process handle is gone', async () => {
  await withVscodeShim(async () => {}, async ({ BridgeManager }) => {
    const closeServer = await createCdpBrowserCloseServer();
    const manager = createManager(BridgeManager);
    const runtime = {
      profile: 'default',
      port: closeServer.server.address().port,
      profilePath: 'C:\\bridgewright-test-profile',
      cdp: {
        Browser: 'Edg/test',
        webSocketDebuggerUrl: `ws://127.0.0.1:${closeServer.server.address().port}/devtools/browser/test`,
      },
      activeSessions: 0,
    };

    try {
      await manager.stopRuntime(runtime);
      assert.equal(closeServer.closeRequested, true);
    } finally {
      closeServer.server.close();
      await manager.stopProcesses();
    }
  });
});

test('launch does not pass an initial blank tab URL to Edge', async () => {
  await withVscodeShim(async () => {}, async ({ BridgeManager }) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridgewright-no-blank-tab-'));
    const profilePath = path.join(root, 'profile');
    const manager = createManager(BridgeManager);
    const originalSpawn = childProcess.spawn;
    let spawnArgs;

    childProcess.spawn = function spawn(file, args) {
      assert.equal(file, 'C:\\Windows\\System32\\where.exe');
      spawnArgs = args;
      return {
        exitCode: 1,
        signalCode: null,
        killed: false,
        once() {},
        kill() {},
      };
    };
    manager.tryRecoverExistingEdgeCdp = async () => undefined;

    try {
      await fs.promises.mkdir(profilePath, { recursive: true });
      await assert.rejects(
        manager.launchEdge('C:\\Windows\\System32\\where.exe', profilePath),
        /Edge exited before writing DevToolsActivePort/,
      );
      assert.ok(spawnArgs, 'Edge should have been launched');
      assert.equal(spawnArgs.includes('about:blank'), false);
    } finally {
      childProcess.spawn = originalSpawn;
      await manager.stopProcesses();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
