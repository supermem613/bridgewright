const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function extractHelperScript() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'manager.ts'), 'utf8');
  const match = source.match(/const HELPER_SCRIPT = String\.raw`([\s\S]*?)`;\r?\n\r?\nexport class/);
  if (!match) {
    throw new Error('Could not find HELPER_SCRIPT in manager.ts');
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
  const cdpPort = await reservePort();
  const tunnelPort = await reservePort();
  return { cdpPort, tunnelPort };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startHelper(options = {}) {
  const ports = options.cdpPort && options.tunnelPort
    ? { cdpPort: options.cdpPort, tunnelPort: options.tunnelPort }
    : await reservePortPair();
  const { cdpPort, tunnelPort } = ports;
  const root = options.root || fs.mkdtempSync(path.join(os.tmpdir(), 'bridgewright-helper-test-'));
  const helperPath = path.join(root, 'bridgewright-helper.js');
  const checkerPath = path.join(root, 'bridgewright-check-endpoint.js');
  const readyPath = path.join(root, 'ready.json');
  const logPath = path.join(root, 'helper.log');
  fs.writeFileSync(helperPath, extractHelperScript(), 'utf8');
  fs.writeFileSync(checkerPath, 'console.log("bridgewright checker");\n', 'utf8');

  const args = [
    helperPath,
  ];
  if (options.replaceExistingFirst) {
    args.push('--replace-existing');
  }
  args.push(
    '--cdp-port',
    String(cdpPort),
    '--tunnel-port',
    String(tunnelPort),
    '--ready-file',
    readyPath,
    '--runtime-log',
    logPath,
    '--connector-timeout-ms',
    String(options.connectorTimeoutMs ?? options.discoveryTimeoutMs ?? 400),
    '--discovery-timeout-ms',
    String(options.discoveryTimeoutMs ?? 400),
  );
  if (options.replaceExisting) {
    args.push('--replace-existing');
  }
  const child = childProcess.spawn(process.execPath, args, { stdio: 'ignore' });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyPath)) {
      const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
      if (ready.status === 'running') {
        return {
          cdpPort,
          tunnelPort,
          root,
          readyPath,
          logPath,
          stop: () => child.kill(),
        };
      }
      if (ready.status === 'error') {
        throw new Error(ready.error || 'helper failed');
      }
    }
    await delay(25);
  }
  child.kill();
  throw new Error('helper did not become ready');
}

function encodeMaskedFrame(payload) {
  const body = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x82, 0x80 | body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const masked = Buffer.from(body);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeFrames(buffer) {
  const frames = [];
  let remaining = buffer;
  while (remaining.length >= 2) {
    let length = remaining[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (remaining.length < 4) break;
      length = remaining.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (remaining.length < 10) break;
      length = Number(remaining.readBigUInt64BE(2));
      offset = 10;
    }
    const masked = (remaining[1] & 0x80) !== 0;
    const maskLength = masked ? 4 : 0;
    if (remaining.length < offset + maskLength + length) break;
    let payload = remaining.subarray(offset + maskLength, offset + maskLength + length);
    if (masked) {
      const mask = remaining.subarray(offset, offset + 4);
      payload = Buffer.from(payload);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    frames.push(payload);
    remaining = remaining.subarray(offset + maskLength + length);
  }
  return { frames, remaining };
}

function connectTunnel(tunnelPort) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const request = http.request({
      host: '127.0.0.1',
      port: tunnelPort,
      path: '/bridgewright-tunnel',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    });
    request.once('upgrade', (_response, socket) => {
      let buffer = Buffer.alloc(0);
      const waiters = [];
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        const decoded = decodeFrames(buffer);
        buffer = decoded.remaining;
        for (const frame of decoded.frames) {
          const waiter = waiters.shift();
          if (waiter) waiter(frame);
        }
      });
      resolve({
        socket,
        send: payload => socket.write(encodeMaskedFrame(payload)),
        nextFrame: () => new Promise(resolveFrame => waiters.push(resolveFrame)),
        close: () => socket.destroy(),
      });
    });
    request.once('error', reject);
    request.end();
  });
}

function httpRequest(port, requestPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      timeout: 2500,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
      });
      response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body }));
    });
    request.once('timeout', () => request.destroy(new Error('HTTP request timed out')));
    request.once('error', reject);
    request.end();
  });
}

function httpGet(port, requestPath) {
  return httpRequest(port, requestPath);
}

function websocketUpgrade(port, requestPath) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    });
    request.once('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ statusCode: response.statusCode });
    });
    request.once('response', response => {
      response.resume();
      response.once('end', () => resolve({ statusCode: response.statusCode }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function withHelper(fn, options) {
  const helper = await startHelper(options);
  try {
    await fn(helper);
  } finally {
    helper.stop();
  }
}

test('helper writes ready state', async () => {
  await withHelper(async helper => {
    const ready = JSON.parse(fs.readFileSync(helper.readyPath, 'utf8'));
    assert.equal(ready.status, 'running');
    assert.equal(ready.cdpPort, helper.cdpPort);
    assert.equal(ready.tunnelPort, helper.tunnelPort);
    const endpoint = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.bridgewright', 'endpoint.json'), 'utf8'));
    assert.equal(endpoint.status, 'starting');
    assert.equal(endpoint.cdpReady, false);
  });


});

test('helper parses boolean replace flag before valued arguments', async () => {
  await withHelper(async helper => {
    const ready = JSON.parse(fs.readFileSync(helper.readyPath, 'utf8'));
    assert.equal(ready.status, 'running');
    assert.equal(ready.cdpPort, helper.cdpPort);
    assert.equal(ready.tunnelPort, helper.tunnelPort);
    assert.match(fs.readFileSync(helper.logPath, 'utf8'), /starting helper/);
  }, { replaceExistingFirst: true });
});

test('/json/version proxies through tunnel and closes response', async () => {
  await withHelper(async helper => {
    const tunnel = await connectTunnel(helper.tunnelPort);
    const pending = httpGet(helper.cdpPort, '/json/version');
    const request = (await tunnel.nextFrame()).toString('utf8');
    assert.match(request, /^GET \/json\/version HTTP\/1\.1/m);
    assert.match(request, /^Connection: close$/m);

    const body = JSON.stringify({
      Browser: 'BridgewrightTest/1',
      'Protocol-Version': '1.3',
      webSocketDebuggerUrl: `ws://127.0.0.1:${helper.cdpPort}/devtools/browser/test`,
    });
    tunnel.send(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    tunnel.close();

    const response = await pending;
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).webSocketDebuggerUrl, `ws://127.0.0.1:${helper.cdpPort}/devtools/browser/test`);
  });
});

test('/json and /json/list proxy discovery endpoints', async () => {
  await withHelper(async helper => {
    for (const pathName of ['/json', '/json/list']) {
      const tunnel = await connectTunnel(helper.tunnelPort);
      const pending = httpGet(helper.cdpPort, pathName);
      const request = (await tunnel.nextFrame()).toString('utf8');
      assert.match(request, new RegExp(`^GET ${pathName.replace('/', '\\/')} HTTP\\/1\\.1`, 'm'));
      const body = JSON.stringify([{ id: 'page-1', webSocketDebuggerUrl: `ws://127.0.0.1:${helper.cdpPort}/devtools/page/page-1` }]);
      tunnel.send(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      tunnel.close();
      const response = await pending;
      assert.equal(response.statusCode, 200);
      assert.equal(JSON.parse(response.body)[0].id, 'page-1');
    }
  });
});

test('discovery endpoints normalize trailing slashes for Playwright compatibility', async () => {
  await withHelper(async helper => {
    for (const [requestPath, upstreamPath] of [
      ['/json/version/', '/json/version'],
      ['/json/version///', '/json/version'],
      ['/json/list/', '/json/list'],
      ['/json/list///', '/json/list'],
      ['/json/', '/json'],
      ['/json/protocol/', '/json/protocol'],
    ]) {
      const tunnel = await connectTunnel(helper.tunnelPort);
      const pending = httpGet(helper.cdpPort, requestPath);
      const request = (await tunnel.nextFrame()).toString('utf8');
      assert.match(request, new RegExp(`^GET ${upstreamPath.replace('/', '\\/')} HTTP\\/1\\.1`, 'm'));
      const body = upstreamPath === '/json/version'
        ? JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${helper.cdpPort}/devtools/browser/test` })
        : JSON.stringify([]);
      tunnel.send(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      tunnel.close();
      const response = await pending;
      assert.equal(response.statusCode, 200);
    }
  });
});

test('discovery endpoint normalization does not accept unsupported lookalike paths', async () => {
  await withHelper(async helper => {
    for (const pathName of ['/json/version/extra/', '/json/list/extra/', '/json/protocol/extra/']) {
      const response = await httpGet(helper.cdpPort, pathName);
      assert.equal(response.statusCode, 404);
      assert.equal(JSON.parse(response.body).path, pathName);
    }
  });
});

test('discovery endpoint normalization preserves query strings', async () => {
  await withHelper(async helper => {
    const tunnel = await connectTunnel(helper.tunnelPort);
    const pending = httpGet(helper.cdpPort, '/json/version/?v=1');
    const request = (await tunnel.nextFrame()).toString('utf8');
    assert.match(request, /^GET \/json\/version\?v=1 HTTP\/1\.1/m);
    const body = JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${helper.cdpPort}/devtools/browser/test` });
    tunnel.send(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    tunnel.close();
    const response = await pending;
    assert.equal(response.statusCode, 200);
  });
});

test('unsupported discovery path returns fast 404 JSON', async () => {
  await withHelper(async helper => {
    const response = await httpGet(helper.cdpPort, '/not-cdp');
    assert.equal(response.statusCode, 404);
    assert.equal(JSON.parse(response.body).error, 'Unsupported CDP discovery path');
  });
});

test('non-GET discovery path returns fast 404 JSON', async () => {
  await withHelper(async helper => {
    const response = await httpRequest(helper.cdpPort, '/json/version', 'POST');
    assert.equal(response.statusCode, 404);
    assert.equal(JSON.parse(response.body).error, 'Unsupported CDP discovery path');
  });
});

test('discovery without connector returns fast 503 JSON', async () => {
  await withHelper(async helper => {
    const started = Date.now();
    const response = await httpGet(helper.cdpPort, '/json/version');
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.body).error, 'Bridgewright local connector unavailable');
    assert.ok(Date.now() - started < 1500);
  }, { discoveryTimeoutMs: 250 });
});

test('discovery with silent connector returns timeout 503 JSON', async () => {
  await withHelper(async helper => {
    const tunnel = await connectTunnel(helper.tunnelPort);
    const pending = httpGet(helper.cdpPort, '/json/version');
    const request = (await tunnel.nextFrame()).toString('utf8');
    assert.match(request, /^GET \/json\/version HTTP\/1\.1/m);
    const response = await pending;
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.body).error, 'Timed out waiting for host browser CDP response');
    tunnel.close();
  }, { discoveryTimeoutMs: 100 });
});

test('malformed upstream discovery response returns 502 JSON', async () => {
  await withHelper(async helper => {
    const tunnel = await connectTunnel(helper.tunnelPort);
    const pending = httpGet(helper.cdpPort, '/json/version');
    await tunnel.nextFrame();
    tunnel.send('not an http response\r\n\r\n');
    tunnel.close();
    const response = await pending;
    assert.equal(response.statusCode, 502);
    assert.equal(JSON.parse(response.body).error, 'Invalid HTTP response from Edge CDP');
  });
});

test('tunnel health endpoint returns bridge metadata', async () => {
  await withHelper(async helper => {
    const response = await httpGet(helper.tunnelPort, '/bridgewright-health');
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.ok, true);
    assert.equal(body.cdpPort, helper.cdpPort);
    assert.equal(body.tunnelPort, helper.tunnelPort);
  });
});

test('helper serves diagnostics checker script from any working directory', async () => {
  await withHelper(async helper => {
    const response = await httpGet(helper.cdpPort, '/bridgewright/check-endpoint.js');
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /application\/javascript/);
    assert.match(response.body, /bridgewright checker/);
  });
});

test('helper health reports connector readiness', async () => {
  await withHelper(async helper => {
    let response = await httpGet(helper.cdpPort, '/bridgewright/health');
    assert.equal(response.statusCode, 200);
    let body = JSON.parse(response.body);
    assert.equal(body.ok, true);
    assert.equal(body.cdpReady, false);
    assert.equal(body.idleConnectorCount, 0);

    const tunnel = await connectTunnel(helper.tunnelPort);
    response = await httpGet(helper.cdpPort, '/bridgewright/diagnose');
    assert.equal(response.statusCode, 200);
    body = JSON.parse(response.body);
    assert.equal(body.cdpReady, true);
    assert.equal(body.idleConnectorCount, 1);
    tunnel.close();
  });
});

test('/devtools websocket upgrade proxies through tunnel', async () => {
  await withHelper(async helper => {
    const tunnel = await connectTunnel(helper.tunnelPort);
    const upgrade = new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const request = http.request({
        host: '127.0.0.1',
        port: helper.cdpPort,
        path: '/devtools/browser/test',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key,
        },
      });
      request.once('upgrade', (response, socket) => {
        socket.destroy();
        resolve(response.statusCode);
      });
      request.once('error', reject);
      request.end();
    });

    const request = (await tunnel.nextFrame()).toString('utf8');
    assert.match(request, /^GET \/devtools\/browser\/test HTTP\/1\.1/m);
    tunnel.send('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    tunnel.close();
    assert.equal(await upgrade, 101);
  });
});

test('/devtools websocket upgrade without connector returns 503', async () => {
  await withHelper(async helper => {
    const response = await websocketUpgrade(helper.cdpPort, '/devtools/browser/test');
    assert.equal(response.statusCode, 503);
  }, { discoveryTimeoutMs: 100 });
});

test('non-devtools websocket upgrade returns 404 without consuming tunnel', async () => {
  await withHelper(async helper => {
    const tunnel = await connectTunnel(helper.tunnelPort);
    const rejected = await websocketUpgrade(helper.cdpPort, '/not-devtools');
    assert.equal(rejected.statusCode, 404);

    const pending = httpGet(helper.cdpPort, '/json/version');
    const request = (await tunnel.nextFrame()).toString('utf8');
    assert.match(request, /^GET \/json\/version HTTP\/1\.1/m);
    const body = JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${helper.cdpPort}/devtools/browser/test` });
    tunnel.send(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    tunnel.close();
    const response = await pending;
    assert.equal(response.statusCode, 200);
  });
});

test('concurrent discovery requests use separate tunnel connectors', async () => {
  await withHelper(async helper => {
    const firstTunnel = await connectTunnel(helper.tunnelPort);
    const secondTunnel = await connectTunnel(helper.tunnelPort);
    const firstPending = httpGet(helper.cdpPort, '/json/version');
    const secondPending = httpGet(helper.cdpPort, '/json/version');

    await firstTunnel.nextFrame();
    await secondTunnel.nextFrame();
    const firstBody = JSON.stringify({ Browser: 'BridgewrightTest/first', webSocketDebuggerUrl: `ws://127.0.0.1:${helper.cdpPort}/devtools/browser/first` });
    const secondBody = JSON.stringify({ Browser: 'BridgewrightTest/second', webSocketDebuggerUrl: `ws://127.0.0.1:${helper.cdpPort}/devtools/browser/second` });
    firstTunnel.send(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(firstBody)}\r\nConnection: close\r\n\r\n${firstBody}`);
    secondTunnel.send(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(secondBody)}\r\nConnection: close\r\n\r\n${secondBody}`);
    firstTunnel.close();
    secondTunnel.close();

    const responses = await Promise.all([firstPending, secondPending]);
    assert.deepEqual(responses.map(response => JSON.parse(response.body).Browser).sort(), [
      'BridgewrightTest/first',
      'BridgewrightTest/second',
    ]);
  });
});
