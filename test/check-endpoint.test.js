const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, '..', '.claude', 'skills', 'bridgewright', 'scripts', 'check-endpoint.js');

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

async function withServer(handler, fn) {
  const port = await reservePort();
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function runChecker(args) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', status => {
      resolve({ status, stdout, stderr });
    });
  });
}

test('check-endpoint verifies version and target list', async () => {
  await withServer((request, response) => {
    if (request.url === '/json/version' || request.url === '/json/version/') {
      response.end(JSON.stringify({
        Browser: 'BridgewrightTest/1',
        'Protocol-Version': '1.3',
        webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/test',
      }));
      return;
    }
    if (request.url === '/json/list') {
      response.end(JSON.stringify([{ id: 'page-1' }]));
      return;
    }
    response.writeHead(404);
    response.end();
  }, async endpoint => {
    const result = await runChecker(['--endpoint', endpoint]);
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.endpoint, endpoint);
    assert.equal(output.targetCount, 1);
  });
});

test('check-endpoint fails when /json/list is not an array', async () => {
  await withServer((request, response) => {
    if (request.url === '/json/version' || request.url === '/json/version/') {
      response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/test' }));
      return;
    }
    if (request.url === '/json/list') {
      response.end(JSON.stringify({ id: 'not-array' }));
      return;
    }
    response.writeHead(404);
    response.end();
  }, async endpoint => {
    const result = await runChecker(['--endpoint', endpoint]);
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.match(output.checked[0].error, /Expected \/json\/list to return an array/);
  });
});

test('check-endpoint includes Bridgewright health on endpoint failure', async () => {
  await withServer((request, response) => {
    if (request.url === '/bridgewright/health') {
      response.end(JSON.stringify({
        ok: true,
        cdpReady: false,
        idleConnectorCount: 0,
      }));
      return;
    }
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Bridgewright local connector unavailable' }));
  }, async endpoint => {
    const result = await runChecker(['--endpoint', endpoint]);
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.match(output.checked[0].error, /HTTP 503/);
    assert.match(output.checked[0].error, /Bridgewright local connector unavailable/);
    assert.equal(output.checked[0].health.cdpReady, false);
    assert.equal(output.checked[0].health.idleConnectorCount, 0);
  });
});

test('check-endpoint catches missing trailing-slash discovery support', async () => {
  await withServer((request, response) => {
    if (request.url === '/json/version') {
      response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/test' }));
      return;
    }
    if (request.url === '/json/list') {
      response.end(JSON.stringify([]));
      return;
    }
    response.writeHead(404);
    response.end();
  }, async endpoint => {
    const result = await runChecker(['--endpoint', endpoint]);
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.match(output.checked[0].error, /HTTP 404/);
  });
});

test('check-endpoint rejects invalid timeout arguments', async () => {
  const result = await runChecker(['--timeout-ms', '0']);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).ok, false);
});

test('check-endpoint identifies stale ready metadata when endpoint refuses connections', async () => {
  const port = await reservePort();
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bridgewright-stale-ready-'));
  const stateFile = path.join(root, 'endpoint.json');
  await fs.promises.writeFile(stateFile, JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`,
    port,
    protocol: 'cdp',
    status: 'running',
    owner: 'bridgewright',
    updatedAt: '2026-06-11T18:13:47.737Z',
    cdpReady: true,
    connectorCount: 4,
  }, null, 2), 'utf8');

  try {
    const result = await runChecker(['--endpoint', `http://127.0.0.1:${port}`, '--state-file', stateFile, '--timeout-ms', '250']);
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.checked[0].staleReadyState, true);
    assert.match(output.checked[0].error, /ECONNREFUSED/);
    assert.equal(output.checked[0].endpointState.status, 'running');
    assert.equal(output.checked[0].endpointState.cdpReady, true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('check-endpoint diagnose skips Playwright when package is unavailable', async () => {
  await withServer((request, response) => {
    if (request.url === '/bridgewright/health') {
      response.end(JSON.stringify({ ok: true, cdpReady: true }));
      return;
    }
    if (request.url === '/json/version' || request.url === '/json/version/') {
      response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/test' }));
      return;
    }
    if (request.url === '/json/list') {
      response.end(JSON.stringify([{ id: 'page-1', type: 'page', title: 'Page 1', url: 'about:blank' }]));
      return;
    }
    response.writeHead(404);
    response.end();
  }, async endpoint => {
    const result = await runChecker(['--endpoint', endpoint, '--diagnose']);
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.health.cdpReady, true);
    assert.equal(output.cdpDiscovery.version, true);
    assert.equal(output.cdpDiscovery.versionSlash, true);
    assert.equal(output.cdpDiscovery.list, true);
    assert.equal(output.playwright.skipped, true);
    assert.match(output.playwright.reason, /playwright package not available/);
  });
});

test('check-endpoint playwright mode requires Playwright when requested', async () => {
  await withServer((request, response) => {
    if (request.url === '/json/version' || request.url === '/json/version/') {
      response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/test' }));
      return;
    }
    if (request.url === '/json/list') {
      response.end(JSON.stringify([{ id: 'page-1', type: 'page', title: 'Page 1', url: 'about:blank' }]));
      return;
    }
    response.writeHead(404);
    response.end();
  }, async endpoint => {
    const result = await runChecker(['--endpoint', endpoint, '--playwright']);
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.match(output.checked[0].error, /Playwright import failed/);
  });
});
