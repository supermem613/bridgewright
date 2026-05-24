#!/usr/bin/env node
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_URL = '';
const NAMED_PROFILE = 'local-smoke';

function parseArgs(argv) {
  const options = {
    defaultUrl: DEFAULT_URL,
    profileUrl: DEFAULT_URL,
    profile: NAMED_PROFILE,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === '--url') {
      options.defaultUrl = requiredValue(name, value);
      options.profileUrl = options.defaultUrl;
      index += 1;
    } else if (name === '--default-url') {
      options.defaultUrl = requiredValue(name, value);
      index += 1;
    } else if (name === '--profile-url') {
      options.profileUrl = requiredValue(name, value);
      index += 1;
    } else if (name === '--profile') {
      options.profile = requiredValue(name, value);
      index += 1;
    } else if (name === '--help' || name === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${name}`);
    }
  }
  return normalizeOptions(options);
}

function normalizeOptions(options = {}) {
  const normalized = {
    defaultUrl: options.defaultUrl || DEFAULT_URL,
    profileUrl: options.profileUrl || options.defaultUrl || DEFAULT_URL,
    profile: options.profile || NAMED_PROFILE,
  };
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(normalized.profile) || normalized.profile === 'default') {
    throw new Error('Profile must be a non-default Bridgewright profile name matching [a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}');
  }
  return normalized;
}

function requiredValue(name, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/local-smoke.js [--url <url>] [--default-url <url>] [--profile-url <url>] [--profile <name>]

Starts Bridgewright's embedded helper and real local connector code without VS Code,
opens Edge through the default endpoint, navigates, closes it through CDP, then
opens named profiles, navigates, and closes/removes them through the profile API.`);
}

function extractHelperScript() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'manager.ts'), 'utf8');
  const match = source.match(/const HELPER_SCRIPT = String\.raw`([\s\S]*?)`;\r?\n\r?\nexport class/);
  if (!match) {
    throw new Error('Could not find HELPER_SCRIPT in src\\manager.ts');
  }
  return match[1];
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function reservePortPair() {
  return {
    cdpPort: await reservePort(),
    tunnelPort: await reservePort(),
  };
}

function installVscodeShim(defaultProfilePath) {
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
      showInformationMessage(message) {
        outputLines.push(message);
        return Promise.resolve(undefined);
      },
      showWarningMessage(message) {
        outputLines.push(message);
        return Promise.resolve(undefined);
      },
      showErrorMessage(message) {
        outputLines.push(message);
        return Promise.resolve(undefined);
      },
      createTerminal() {
        throw new Error('The local smoke harness does not start VS Code terminals');
      },
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration(section) {
        assert.equal(section, 'bridgewright');
        return {
          get(name, fallback) {
            if (name === 'edgeUserDataDir') return defaultProfilePath;
            if (name === 'connectorPoolSize') return 4;
            return fallback;
          },
        };
      },
      fs: {},
    },
    env: {
      clipboard: {
        writeText() {
          return Promise.resolve(undefined);
        },
      },
    },
    Uri: {
      parse(value) {
        return { path: new URL(value).pathname, toString: () => value };
      },
      joinPath(base, ...segments) {
        const joinedPath = path.posix.join(base.path, ...segments);
        return { path: joinedPath, toString: () => joinedPath };
      },
    },
    FileSystemError: class FileSystemError extends Error {},
  };
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') {
      return shim;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  return {
    outputLines,
    restore() {
      Module._load = originalLoad;
    },
  };
}

async function startHelper(root, cdpPort, tunnelPort) {
  const runtimeRoot = path.join(root, 'helper-runtime');
  const remoteStateRoot = path.join(root, 'remote-state');
  await fs.promises.mkdir(runtimeRoot, { recursive: true });
  const helperPath = path.join(runtimeRoot, 'bridgewright-helper.cjs');
  const readyPath = path.join(runtimeRoot, 'ready.json');
  const logPath = path.join(runtimeRoot, 'helper.log');
  await fs.promises.writeFile(helperPath, extractHelperScript(), 'utf8');
  const child = childProcess.spawn(process.execPath, [
    helperPath,
    '--replace-existing',
    '--cdp-port',
    String(cdpPort),
    '--tunnel-port',
    String(tunnelPort),
    '--ready-file',
    readyPath,
    '--runtime-log',
    logPath,
    '--root',
    remoteStateRoot,
    '--connector-timeout-ms',
    '3000',
    '--discovery-timeout-ms',
    '20000',
  ], { stdio: 'ignore' });

  try {
    await waitFor(async () => {
      if (!fs.existsSync(readyPath)) return false;
      const ready = JSON.parse(await fs.promises.readFile(readyPath, 'utf8'));
      if (ready.status === 'error') {
        const log = await readTextIfExists(logPath);
        throw new Error(`Helper failed: ${ready.error || 'unknown error'}${log ? `\n${log}` : ''}`);
      }
      return ready.status === 'running';
    }, 5000, 'Helper did not become ready');
  } catch (error) {
    child.kill();
    throw error;
  }

  return {
    child,
    stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    },
  };
}

async function readTextIfExists(filePath) {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function httpRequest(port, requestPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      timeout: 20000,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({ statusCode: response.statusCode, body });
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error(`Timed out calling ${method} ${requestPath}`));
    });
    request.on('error', reject);
    request.end();
  });
}

async function httpJson(port, requestPath, method = 'GET') {
  const response = await httpRequest(port, requestPath, method);
  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${method} ${requestPath} returned HTTP ${response.statusCode}: ${response.body}`);
  }
  return JSON.parse(response.body);
}

function encodeClientFrame(payload) {
  const body = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x81, 0x80 | body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const masked = Buffer.from(body);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function encodeClientCloseFrame() {
  const mask = crypto.randomBytes(4);
  return Buffer.from([0x88, 0x80, ...mask]);
}

function createWebSocketClient(rawUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect({ host: url.hostname, port: Number(url.port) || 80 });
    let handshake = Buffer.alloc(0);
    let frameBuffer = Buffer.alloc(0);
    let open = false;
    let settled = false;
    let nextId = 1;
    const pending = new Map();
    const eventWaiters = new Map();

    const fail = (error) => {
      for (const { reject: rejectPending } of pending.values()) {
        rejectPending(error);
      }
      pending.clear();
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    socket.once('connect', () => {
      socket.write([
        `GET ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${key}`,
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('error', error => {
      if (!open || pending.size > 0) {
        fail(error);
      }
    });
    socket.on('data', chunk => {
      if (!open) {
        handshake = Buffer.concat([handshake, chunk]);
        const marker = handshake.indexOf('\r\n\r\n');
        if (marker < 0) return;
        const head = handshake.subarray(0, marker).toString('latin1');
        if (!/^HTTP\/1\.1 101\b/m.test(head)) {
          socket.destroy();
          fail(new Error(`WebSocket upgrade failed:\n${head}`));
          return;
        }
        open = true;
        settled = true;
        frameBuffer = handshake.subarray(marker + 4);
        resolve(client);
      } else {
        frameBuffer = Buffer.concat([frameBuffer, chunk]);
      }
      consumeFrames();
    });
    socket.once('close', () => {
      const error = new Error('WebSocket closed');
      for (const { reject: rejectPending } of pending.values()) {
        rejectPending(error);
      }
      pending.clear();
    });

    function consumeFrames() {
      while (frameBuffer.length >= 2) {
        const opcode = frameBuffer[0] & 0x0f;
        let length = frameBuffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (frameBuffer.length < 4) return;
          length = frameBuffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (frameBuffer.length < 10) return;
          length = Number(frameBuffer.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = (frameBuffer[1] & 0x80) !== 0;
        const maskLength = masked ? 4 : 0;
        if (frameBuffer.length < offset + maskLength + length) return;
        let payload = frameBuffer.subarray(offset + maskLength, offset + maskLength + length);
        if (masked) {
          const mask = frameBuffer.subarray(offset, offset + 4);
          payload = Buffer.from(payload);
          for (let index = 0; index < payload.length; index += 1) {
            payload[index] ^= mask[index % 4];
          }
        }
        frameBuffer = frameBuffer.subarray(offset + maskLength + length);
        if (opcode === 0x8) {
          socket.end();
          return;
        }
        if (opcode === 0x1) {
          handleMessage(JSON.parse(payload.toString('utf8')));
        }
      }
    }

    function handleMessage(message) {
      if (message.id && pending.has(message.id)) {
        const { resolve: resolvePending, reject: rejectPending } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          rejectPending(new Error(JSON.stringify(message.error)));
        } else {
          resolvePending(message.result);
        }
        return;
      }
      if (message.method && eventWaiters.has(message.method)) {
        const waiters = eventWaiters.get(message.method);
        eventWaiters.delete(message.method);
        for (const waiter of waiters) {
          waiter(message.params);
        }
      }
    }

    const client = {
      send(method, params = {}) {
        const id = nextId;
        nextId += 1;
        const payload = JSON.stringify({ id, method, params });
        return new Promise((resolvePending, rejectPending) => {
          pending.set(id, { resolve: resolvePending, reject: rejectPending });
          socket.write(encodeClientFrame(payload));
        });
      },
      waitForEvent(method, timeoutMs = 15000) {
        return new Promise((resolveEvent, rejectEvent) => {
          const timer = setTimeout(() => {
            rejectEvent(new Error(`Timed out waiting for CDP event ${method}`));
          }, timeoutMs);
          const waiter = params => {
            clearTimeout(timer);
            resolveEvent(params);
          };
          const waiters = eventWaiters.get(method) || [];
          waiters.push(waiter);
          eventWaiters.set(method, waiters);
        });
      },
      close() {
        if (!socket.destroyed) {
          socket.write(encodeClientCloseFrame());
          socket.destroy();
        }
      },
    };
  });
}

async function openAndNavigate(cdpPort, routePrefix, url) {
  const version = await httpJson(cdpPort, `${routePrefix}/json/version`);
  assert.ok(version.webSocketDebuggerUrl, 'version response must include webSocketDebuggerUrl');
  const browser = await createWebSocketClient(version.webSocketDebuggerUrl);
  const created = await browser.send('Target.createTarget', { url: 'about:blank' });
  assert.ok(created.targetId, 'Target.createTarget must return targetId');
  const page = await createWebSocketClient(`ws://127.0.0.1:${cdpPort}${routePrefix}/devtools/page/${created.targetId}`);
  await page.send('Page.enable');
  const loaded = page.waitForEvent('Page.loadEventFired');
  await page.send('Page.navigate', { url });
  await loaded;
  const evaluated = await page.send('Runtime.evaluate', {
    expression: 'JSON.stringify({ href: location.href, title: document.title, body: document.body ? document.body.textContent : "" })',
    returnByValue: true,
  });
  const pageState = JSON.parse(evaluated.result.value);
  page.close();
  return {
    browser,
    targetId: created.targetId,
    pageState,
  };
}

async function closeBrowserTargets(browser) {
  const targets = await browser.send('Target.getTargets');
  for (const target of targets.targetInfos || []) {
    if (target.type === 'page') {
      await browser.send('Target.closeTarget', { targetId: target.targetId });
    }
  }
}

function makeDataUrl(title, body) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><title>${title}</title><main>${body}</main>`)}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertPageState(actual, expected) {
  if (!expected.title) {
    return;
  }
  assert.equal(actual.title, expected.title);
  assert.match(actual.body, expected.bodyPattern);
}

async function expectProfile(profiles, expected) {
  const profile = profiles.profiles.find(candidate => candidate.profile === expected.profile);
  assert.ok(profile, `Expected profile "${expected.profile}" to be listed`);
  assert.equal(profile.running, expected.running);
  assert.equal(profile.durable, expected.durable);
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function runLocalSmoke(rawOptions = {}, reporter = console) {
  const options = normalizeOptions(rawOptions);
  const secondProfile = options.profile === 'local-smoke-other' ? 'local-smoke-two' : 'local-smoke-other';
  const multiProfile = options.profile === 'local-smoke-multi' ? 'local-smoke-multi-two' : 'local-smoke-multi';
  const pages = {
    defaultFirst: {
      title: 'Bridgewright default first',
      url: options.defaultUrl || makeDataUrl('Bridgewright default first', 'default profile first navigation'),
      expectedTitle: options.defaultUrl ? undefined : 'Bridgewright default first',
      expectedBodyPattern: options.defaultUrl ? undefined : /default profile first navigation/,
    },
    defaultSecond: {
      title: 'Bridgewright default second',
      body: 'default profile still works after close',
      url: makeDataUrl('Bridgewright default second', 'default profile still works after close'),
    },
    namedFirst: {
      title: `Bridgewright ${options.profile}`,
      url: options.profileUrl || makeDataUrl(`Bridgewright ${options.profile}`, `${options.profile} named profile navigation`),
      expectedTitle: options.profileUrl ? undefined : `Bridgewright ${options.profile}`,
      expectedBodyPattern: options.profileUrl ? undefined : new RegExp(escapeRegExp(`${options.profile} named profile navigation`)),
    },
    namedSecond: {
      title: `Bridgewright ${secondProfile}`,
      body: `${secondProfile} named profile navigation`,
      url: makeDataUrl(`Bridgewright ${secondProfile}`, `${secondProfile} named profile navigation`),
    },
    namedMultiFirst: {
      title: `Bridgewright ${multiProfile} first`,
      body: `${multiProfile} first client navigation`,
      url: makeDataUrl(`Bridgewright ${multiProfile} first`, `${multiProfile} first client navigation`),
    },
    namedMultiSecond: {
      title: `Bridgewright ${multiProfile} second`,
      body: `${multiProfile} second client navigation`,
      url: makeDataUrl(`Bridgewright ${multiProfile} second`, `${multiProfile} second client navigation`),
    },
    defaultFinal: {
      title: 'Bridgewright default final',
      body: 'default profile works after named profile cleanup',
      url: makeDataUrl('Bridgewright default final', 'default profile works after named profile cleanup'),
    },
  };
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridgewright-local-smoke-'));
  const defaultProfilePath = path.join(root, 'default-edge-user-data');
  const shim = installVscodeShim(defaultProfilePath);
  const helperPorts = await reservePortPair();
  let helper;
  let manager;
  let stopping = false;

  async function cleanup() {
    if (stopping) return;
    stopping = true;
    if (manager) {
      await manager.stopProcesses();
    }
    if (helper) {
      helper.stop();
    }
    shim.restore();
    await fs.promises.rm(root, { recursive: true, force: true });
  }

  process.once('SIGINT', () => {
    cleanup().finally(() => process.exit(130));
  });
  process.once('SIGTERM', () => {
    cleanup().finally(() => process.exit(143));
  });

  try {
    const { BridgeManager } = require('../dist/manager.js');
    helper = await startHelper(root, helperPorts.cdpPort, helperPorts.tunnelPort);
    manager = new BridgeManager({ extensionUri: { path: process.cwd(), toString: () => process.cwd() }, subscriptions: [] });
    manager.rootPath = path.join(root, 'bridgewright-state');
    manager.logsPath = path.join(manager.rootPath, 'logs');
    manager.namedProfilesPath = path.join(manager.rootPath, 'profiles');
    manager.statePath = path.join(manager.rootPath, 'state.json');
    manager.profilePath = defaultProfilePath;
    manager.state = {
      status: 'running',
      endpoint: `http://127.0.0.1:${helperPorts.cdpPort}`,
      remotePort: helperPorts.cdpPort,
      tunnelPort: helperPorts.tunnelPort,
      profilePath: defaultProfilePath,
      updatedAt: new Date().toISOString(),
    };
    await manager.ensureStorage();
    await manager.cleanupNamedProfiles();
    manager.openLog();
    manager.setStatus('running');
    await manager.startConnectorPool(new URL(`http://127.0.0.1:${helperPorts.tunnelPort}/bridgewright-tunnel`));

    reporter.log(`Bridgewright local smoke endpoint: http://127.0.0.1:${helperPorts.cdpPort}`);
    reporter.log(`Opening default profile and navigating to ${pages.defaultFirst.url}`);
    const defaultFirst = await openAndNavigate(helperPorts.cdpPort, '', pages.defaultFirst.url);
    assertPageState(defaultFirst.pageState, {
      title: pages.defaultFirst.expectedTitle,
      bodyPattern: pages.defaultFirst.expectedBodyPattern,
    });
    assert.ok(manager.runtimes.has('default'), 'Default runtime should be tracked after navigation');
    await expectProfile(await httpJson(helperPorts.cdpPort, '/profiles'), {
      profile: 'default',
      running: true,
      durable: true,
    });

    const rejectedDefaultClose = await httpRequest(helperPorts.cdpPort, '/profiles/default/close', 'POST');
    assert.equal(rejectedDefaultClose.statusCode, 400);
    assert.ok(manager.runtimes.has('default'), 'Default runtime should survive rejected default close');

    await closeBrowserTargets(defaultFirst.browser);
    defaultFirst.browser.close();
    await waitFor(() => !manager.runtimes.has('default'), 10000, 'Default Edge runtime did not exit after closing page targets');
    assert.ok(fs.existsSync(defaultProfilePath), 'Default profile directory should remain after closing default runtime');
    reporter.log('Default profile navigation, close rejection, and target close: ok');

    reporter.log(`Reopening default profile and navigating to ${pages.defaultSecond.url}`);
    const defaultSecond = await openAndNavigate(helperPorts.cdpPort, '', pages.defaultSecond.url);
    assertPageState(defaultSecond.pageState, {
      title: pages.defaultSecond.title,
      bodyPattern: /default profile still works after close/,
    });
    await closeBrowserTargets(defaultSecond.browser);
    defaultSecond.browser.close();
    await waitFor(() => !manager.runtimes.has('default'), 10000, 'Default Edge runtime did not exit after second close');
    reporter.log('Default profile reopen after close: ok');

    reporter.log(`Opening named profile "${options.profile}" and navigating to ${pages.namedFirst.url}`);
    const profilePrefix = `/profiles/${encodeURIComponent(options.profile)}`;
    const namedFirst = await openAndNavigate(helperPorts.cdpPort, profilePrefix, pages.namedFirst.url);
    assertPageState(namedFirst.pageState, {
      title: pages.namedFirst.expectedTitle,
      bodyPattern: pages.namedFirst.expectedBodyPattern,
    });
    await expectProfile(await httpJson(helperPorts.cdpPort, '/profiles'), {
      profile: options.profile,
      running: true,
      durable: false,
    });
    assert.ok(fs.existsSync(path.join(manager.namedProfilesPath, options.profile)), 'Named profile directory should exist while running');
    namedFirst.browser.close();
    await waitFor(() => !manager.runtimes.has(options.profile), 10000, 'Named Edge runtime did not exit after last CDP disconnect');
    await waitFor(() => !fs.existsSync(path.join(manager.namedProfilesPath, options.profile)), 10000, 'Named profile directory was not removed after last CDP disconnect');
    reporter.log(`Named profile "${options.profile}" navigation and disconnect cleanup: ok`);

    reporter.log(`Opening second named profile "${secondProfile}" and navigating to ${pages.namedSecond.url}`);
    const secondProfilePrefix = `/profiles/${encodeURIComponent(secondProfile)}`;
    const namedSecond = await openAndNavigate(helperPorts.cdpPort, secondProfilePrefix, pages.namedSecond.url);
    assertPageState(namedSecond.pageState, {
      title: pages.namedSecond.title,
      bodyPattern: new RegExp(escapeRegExp(`${secondProfile} named profile navigation`)),
    });
    const profilesWithSecond = await httpJson(helperPorts.cdpPort, '/profiles');
    await expectProfile(profilesWithSecond, {
      profile: secondProfile,
      running: true,
      durable: false,
    });
    assert.equal(profilesWithSecond.profiles.some(profile => profile.profile === options.profile), false);
    const removeResponse = await httpJson(helperPorts.cdpPort, `${secondProfilePrefix}/remove`, 'POST');
    assert.equal(removeResponse.profile, secondProfile);
    namedSecond.browser.close();
    await waitFor(() => !manager.runtimes.has(secondProfile), 10000, 'Second named Edge runtime did not exit after profile remove');
    await waitFor(() => !fs.existsSync(path.join(manager.namedProfilesPath, secondProfile)), 10000, 'Second named profile directory was not removed after profile remove');
    reporter.log(`Second named profile "${secondProfile}" navigation and remove: ok`);

    reporter.log(`Opening two clients for named profile "${multiProfile}"`);
    const multiProfilePrefix = `/profiles/${encodeURIComponent(multiProfile)}`;
    const multiFirst = await openAndNavigate(helperPorts.cdpPort, multiProfilePrefix, pages.namedMultiFirst.url);
    const multiSecond = await openAndNavigate(helperPorts.cdpPort, multiProfilePrefix, pages.namedMultiSecond.url);
    assertPageState(multiFirst.pageState, {
      title: pages.namedMultiFirst.title,
      bodyPattern: new RegExp(escapeRegExp(`${multiProfile} first client navigation`)),
    });
    assertPageState(multiSecond.pageState, {
      title: pages.namedMultiSecond.title,
      bodyPattern: new RegExp(escapeRegExp(`${multiProfile} second client navigation`)),
    });
    multiFirst.browser.close();
    await waitFor(() => {
      const runtime = manager.runtimes.get(multiProfile);
      return runtime && runtime.activeSessions === 1;
    }, 10000, 'Named profile should stay running while another CDP client remains connected');
    assert.ok(fs.existsSync(path.join(manager.namedProfilesPath, multiProfile)), 'Named profile directory should remain while another CDP client is connected');
    multiSecond.browser.close();
    await waitFor(() => !manager.runtimes.has(multiProfile), 10000, 'Multi-client named Edge runtime did not exit after final CDP disconnect');
    await waitFor(() => !fs.existsSync(path.join(manager.namedProfilesPath, multiProfile)), 10000, 'Multi-client named profile directory was not removed after final CDP disconnect');
    reporter.log(`Multi-client named profile "${multiProfile}" disconnect cleanup: ok`);

    reporter.log(`Verifying default profile still works after named profile cleanup at ${pages.defaultFinal.url}`);
    const defaultFinal = await openAndNavigate(helperPorts.cdpPort, '', pages.defaultFinal.url);
    assertPageState(defaultFinal.pageState, {
      title: pages.defaultFinal.title,
      bodyPattern: /default profile works after named profile cleanup/,
    });
    await closeBrowserTargets(defaultFinal.browser);
    defaultFinal.browser.close();
    await waitFor(() => !manager.runtimes.has('default'), 10000, 'Default Edge runtime did not exit after final close');
    const finalProfiles = await httpJson(helperPorts.cdpPort, '/profiles');
    assert.deepEqual(finalProfiles.profiles, [
      {
        profile: 'default',
        running: false,
        durable: true,
      },
    ]);
    reporter.log('Default profile post-named-cleanup health: ok');

    await cleanup();
    reporter.log('Bridgewright local e2e: ok');
    return {
      endpoint: `http://127.0.0.1:${helperPorts.cdpPort}`,
      profile: options.profile,
    };
  } catch (error) {
    await cleanup();
    const details = [
      error && error.stack ? error.stack : String(error),
      shim.outputLines.length > 0 ? `\nBridgewright output:\n${shim.outputLines.join('\n')}` : '',
    ].join('');
    throw new Error(`Bridgewright local smoke failed\n${details}`, { cause: error });
  }
}

async function main() {
  try {
    await runLocalSmoke(parseArgs(process.argv));
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  runLocalSmoke,
};

if (require.main === module) {
  void main();
}
