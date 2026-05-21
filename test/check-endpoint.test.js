const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
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
    if (request.url === '/json/version') {
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
    if (request.url === '/json/version') {
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

test('check-endpoint rejects invalid timeout arguments', async () => {
  const result = await runChecker(['--timeout-ms', '0']);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).ok, false);
});
