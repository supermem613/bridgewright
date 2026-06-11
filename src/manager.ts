import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createRemoteLauncherScript, remoteShellQuote, resolveRemoteRuntimePath } from './launcher';
import { encodeMaskedWebSocketFrame } from './websocket';

type BridgeStatus = 'stopped' | 'starting' | 'running' | 'error';

interface BridgeState {
  readonly status: BridgeStatus;
  readonly endpoint?: string;
  readonly browser?: string;
  readonly localPort?: number;
  readonly remotePort?: number;
  readonly tunnelPort?: number;
  readonly profilePath: string;
  readonly updatedAt: string;
  readonly error?: string;
}

interface CdpVersion {
  readonly Browser?: string;
  readonly webSocketDebuggerUrl?: string;
}

interface EdgeRuntime {
  readonly profile: string;
  readonly port: number;
  readonly profilePath: string;
  readonly process?: childProcess.ChildProcess;
  readonly cdp: CdpVersion;
  activeSessions: number;
}

interface RoutedPayload {
  readonly profile: string;
  readonly payload: Buffer;
  readonly management?: {
    readonly action: 'list' | 'close' | 'remove';
    readonly profile?: string;
  };
}

interface BridgeWebSocket {
  readonly closed: Promise<void>;
  send(payload: Buffer): void;
  close(): void;
  onData(handler: (payload: Buffer) => void): void;
}

interface RemoteHelper {
  readonly readyUri: vscode.Uri;
  readonly logUri: vscode.Uri;
}

class RemoteHelperError extends Error {
}

const DEFAULT_PROFILE = 'default';
const PROFILE_NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/;
const PROFILE_DISCONNECT_GRACE_MS = 750;

function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name);
}

function decodeProfile(segment: string): string {
  const profile = decodeURIComponent(segment);
  if (!isValidProfileName(profile)) {
    throw new Error(`Invalid Bridgewright profile name: ${profile}`);
  }
  return profile;
}

function rewriteRequestTarget(payload: Buffer, targetUrl: string): Buffer {
  const marker = payload.indexOf('\r\n');
  if (marker < 0) {
    throw new Error('Could not parse CDP request line');
  }
  const line = payload.subarray(0, marker).toString('latin1');
  const parts = line.split(' ');
  if (parts.length < 3) {
    throw new Error('Invalid CDP request line');
  }
  parts[1] = targetUrl;
  return Buffer.concat([
    Buffer.from(`${parts.join(' ')}\r\n`, 'latin1'),
    payload.subarray(marker + 2),
  ]);
}

function parseRoutedPayload(payload: Buffer): RoutedPayload {
  const marker = payload.indexOf('\r\n');
  if (marker < 0) {
    throw new Error('Could not parse CDP request line');
  }
  const line = payload.subarray(0, marker).toString('latin1');
  const [method, rawTarget] = line.split(' ');
  if (!method || !rawTarget) {
    throw new Error('Invalid CDP request line');
  }

  const parsed = new URL(rawTarget, 'http://127.0.0.1');
  if (method === 'GET' && parsed.pathname === '/profiles') {
    return {
      profile: DEFAULT_PROFILE,
      payload,
      management: { action: 'list' },
    };
  }

  const rawPath = rawTarget.split(/[?#]/, 1)[0] || '/';
  const profileMatch = /^\/profiles\/([^/]+)(\/.*)?$/.exec(rawPath);
  if (!profileMatch) {
    return { profile: DEFAULT_PROFILE, payload };
  }

  const profile = decodeProfile(profileMatch[1]);
  const innerPath = profileMatch[2] ?? '/';
  if (method === 'POST' && (innerPath === '/close' || innerPath === '/remove')) {
    return {
      profile,
      payload,
      management: {
        action: innerPath === '/close' ? 'close' : 'remove',
        profile,
      },
    };
  }

  const targetUrl = `${innerPath}${parsed.search}`;
  return {
    profile,
    payload: rewriteRequestTarget(payload, targetUrl),
  };
}

function httpJsonResponse(statusCode: number, payload: unknown): Buffer {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const statusText = statusCode >= 200 && statusCode < 300 ? 'OK' : 'Error';
  return Buffer.from([
    `HTTP/1.1 ${statusCode} ${statusText}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body,
  ].join('\r\n'), 'utf8');
}

const HELPER_SCRIPT = String.raw`
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const name = process.argv[i];
  if (name === '--replace-existing') {
    args.set(name, 'true');
    continue;
  }
  args.set(name, process.argv[i + 1]);
  i += 1;
}

const cdpPort = Number.parseInt(args.get('--cdp-port') || '37373', 10);
const tunnelPort = Number.parseInt(args.get('--tunnel-port') || '37374', 10);
const connectorTimeoutMs = Number.parseInt(args.get('--connector-timeout-ms') || '3000', 10);
const discoveryTimeoutMs = Number.parseInt(args.get('--discovery-timeout-ms') || '20000', 10);
const replaceExisting = args.has('--replace-existing');
const readyFile = args.get('--ready-file');
const runtimeLog = args.get('--runtime-log');
const root = args.get('--root') || path.join(os.homedir(), '.bridgewright');
const logs = path.join(root, 'logs');
const checkerScriptFile = path.join(path.dirname(path.resolve(process.argv[1])), 'bridgewright-check-endpoint.js');
fs.mkdirSync(logs, { recursive: true });

function log(message) {
  const line = new Date().toISOString() + ' ' + message + '\n';
  fs.appendFileSync(path.join(logs, 'helper.log'), line);
  if (runtimeLog) {
    fs.appendFileSync(runtimeLog, line);
  }
}

function writeState(status, extra = {}) {
  const payload = {
    endpoint: 'http://127.0.0.1:' + cdpPort,
    port: cdpPort,
    protocol: 'cdp',
    status,
    owner: 'bridgewright',
    updatedAt: new Date().toISOString(),
    ...extra
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'endpoint.json'), JSON.stringify(payload, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify(payload, null, 2) + '\n');
}

function writeWaitingForConnectorState() {
  writeState('starting', {
    cdpReady: false,
    detail: 'Waiting for a local Bridgewright connector'
  });
}

function writeReady(status, extra = {}) {
  if (!readyFile) return;
  const payload = {
    status,
    cdpPort,
    tunnelPort,
    owner: 'bridgewright',
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    ...extra
  };
  fs.writeFileSync(readyFile, JSON.stringify(payload, null, 2) + '\n');
}

function stopExistingHelpers() {
  if (!replaceExisting) return;
  if (!fs.existsSync('/proc')) {
    log('replace-existing requested but /proc is unavailable');
    return;
  }
  const self = process.pid;
  const scriptPath = path.resolve(process.argv[1]);
  const stopped = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    if (pid === self) continue;
    try {
      const raw = fs.readFileSync(path.join('/proc', entry, 'cmdline'), 'utf8');
      const parts = raw.split('\0').filter(Boolean);
      const candidate = parts.find(part => path.resolve(part) === scriptPath);
      if (candidate) {
        process.kill(pid, 'SIGTERM');
        log('stopped existing helper pid=' + pid);
        stopped.push(pid);
      }
    } catch {
      // Process disappeared or is not readable.
    }
  }
  const deadline = Date.now() + 750;
  let remaining = stopped;
  while (remaining.length > 0 && Date.now() < deadline) {
    remaining = remaining.filter(pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (remaining.length > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  if (remaining.length > 0) {
    log('existing helper pid(s) still exiting: ' + remaining.join(','));
  }
}

function encodeFrame(payload) {
  const body = Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x82, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function createWebSocket(socket, maskedInput) {
  let buffer = Buffer.alloc(0);
  let closed = false;
  const dataHandlers = [];
  const closeHandlers = [];

  function close() {
    if (closed) return;
    closed = true;
    socket.destroy();
    for (const handler of closeHandlers) handler();
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const bigLength = buffer.readBigUInt64BE(2);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          close();
          return;
        }
        length = Number(bigLength);
        offset = 10;
      }

      const masked = (buffer[1] & 0x80) !== 0;
      const maskLength = masked ? 4 : 0;
      if (maskedInput && !masked) {
        close();
        return;
      }
      if (buffer.length < offset + maskLength + length) return;

      let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(offset + maskLength + length);

      if (opcode === 0x8) {
        close();
        return;
      }
      if (opcode === 0x2 || opcode === 0x1) {
        for (const handler of dataHandlers) handler(payload);
      }
    }
  });
  socket.once('close', close);
  socket.once('error', close);

  return {
    send(payload) {
      if (!closed) socket.write(encodeFrame(payload));
    },
    close,
    onData(handler) {
      dataHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    }
  };
}

const idleTunnels = [];
const waiters = [];

function addTunnel(tunnel) {
  tunnel.onClose(() => {
    const index = idleTunnels.indexOf(tunnel);
    if (index >= 0) idleTunnels.splice(index, 1);
    if (idleTunnels.length === 0) {
      writeWaitingForConnectorState();
    }
  });
  if (waiters.length > 0) {
    const waiter = waiters.shift();
    clearTimeout(waiter.timer);
    waiter(tunnel);
  } else {
    idleTunnels.push(tunnel);
  }
  writeState('running', {
    cdpReady: true,
    connectorCount: idleTunnels.length
  });
}

function takeTunnel(timeoutMs = connectorTimeoutMs) {
  const tunnel = idleTunnels.shift();
  if (tunnel) return Promise.resolve(tunnel);
  return new Promise((resolve, reject) => {
    const waiter = (tunnel) => resolve(tunnel);
    waiter.timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error('Timed out waiting for a local connector'));
    }, timeoutMs);
    waiters.push(waiter);
  });
}

const tunnelServer = http.createServer((request, response) => {
  if (request.url === '/bridgewright-health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, cdpPort, tunnelPort, owner: 'bridgewright' }) + '\n');
    return;
  }
  response.writeHead(426);
  response.end('Bridgewright tunnel requires WebSocket upgrade\n');
});

tunnelServer.on('upgrade', (request, socket) => {
  if (request.url !== '/bridgewright-tunnel') {
    socket.destroy();
    return;
  }
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + accept,
    '',
    ''
  ].join('\r\n'));
  log('local connector attached');
  addTunnel(createWebSocket(socket, true));
});

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2) + '\n';
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    connection: 'close'
  });
  response.end(body);
}

function serveBridgewrightHealth(response) {
  sendJson(response, 200, {
    ok: true,
    endpoint: 'http://127.0.0.1:' + cdpPort,
    cdpPort,
    tunnelPort,
    cdpReady: idleTunnels.length > 0,
    idleConnectorCount: idleTunnels.length,
    pendingRequestCount: waiters.length,
    owner: 'bridgewright'
  });
}

function serveCheckerScript(request, response) {
  if (request.method !== 'GET') {
    sendJson(response, 404, { error: 'Unsupported Bridgewright diagnostics path', path: request.url || '/' });
    return;
  }
  fs.readFile(checkerScriptFile, (error, body) => {
    if (error) {
      sendJson(response, 404, { error: 'Bridgewright diagnostic checker script is unavailable', path: checkerScriptFile });
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'content-length': body.length,
      connection: 'close'
    });
    response.end(body);
  });
}

function normalizeDiscoveryUrl(rawUrl) {
  const parsed = new URL(rawUrl || '/', 'http://127.0.0.1');
  const routePath = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/+$/, '');
  return {
    profile: 'default',
    routePath,
    targetUrl: routePath + parsed.search,
    facadeUrl: routePath + parsed.search
  };
}

function isValidProfileName(name) {
  return /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(name);
}

function normalizeProfiledUrl(rawUrl) {
  const parsed = new URL(rawUrl || '/', 'http://127.0.0.1');
  const rawPath = (rawUrl || '/').split(/[?#]/, 1)[0] || '/';
  const routePath = rawPath === '/' ? '/' : rawPath.replace(/\/+$/, '');
  const match = /^\/profiles\/([^/]+)(\/.*)?$/.exec(routePath);
  if (!match) {
    return normalizeDiscoveryUrl(rawUrl);
  }
  const profile = decodeURIComponent(match[1]);
  if (!isValidProfileName(profile)) {
    return { profile, routePath, targetUrl: routePath + parsed.search, facadeUrl: routePath + parsed.search, invalidProfile: true };
  }
  const innerPath = match[2] || '/';
  return {
    profile,
    routePath: innerPath === '/' ? '/' : innerPath.replace(/\/+$/, ''),
    targetUrl: (innerPath === '/' ? '/' : innerPath.replace(/\/+$/, '')) + parsed.search,
    facadeUrl: routePath + parsed.search
  };
}

function prefixProfilePath(profile, pathValue) {
  if (profile === 'default') return pathValue;
  if (!pathValue.startsWith('/devtools/')) return pathValue;
  return '/profiles/' + encodeURIComponent(profile) + pathValue;
}

function rewriteWsUrl(profile, value) {
  if (typeof value !== 'string') return value;
  try {
    const parsed = new URL(value);
    if (!parsed.pathname.startsWith('/profiles/')) {
      parsed.pathname = prefixProfilePath(profile, parsed.pathname);
    }
    parsed.host = '127.0.0.1:' + cdpPort;
    return parsed.toString();
  } catch {
    return value;
  }
}

function rewriteDevtoolsFrontendUrl(profile, value) {
  if (typeof value !== 'string') return value;
  try {
    const parsed = new URL(value, 'http://127.0.0.1:' + cdpPort);
    for (const key of ['ws', 'wss']) {
      const current = parsed.searchParams.get(key);
      if (!current) continue;
      const separator = current.indexOf('/');
      if (separator < 0) continue;
      const host = '127.0.0.1:' + cdpPort;
      const pathPart = prefixProfilePath(profile, current.slice(separator));
      parsed.searchParams.set(key, host + pathPart);
    }
    return value.startsWith('/') ? parsed.pathname + parsed.search + parsed.hash : parsed.toString();
  } catch {
    return value;
  }
}

function rewriteDiscoveryJson(profile, payload) {
  const rewriteEntry = entry => {
    if (!entry || typeof entry !== 'object') return entry;
    return {
      ...entry,
      webSocketDebuggerUrl: rewriteWsUrl(profile, entry.webSocketDebuggerUrl),
      devtoolsFrontendUrl: rewriteDevtoolsFrontendUrl(profile, entry.devtoolsFrontendUrl),
      devtoolsFrontendUrlCompat: rewriteDevtoolsFrontendUrl(profile, entry.devtoolsFrontendUrlCompat),
    };
  };
  return Array.isArray(payload) ? payload.map(rewriteEntry) : rewriteEntry(payload);
}

function serializeRequest(request, targetUrl) {
  const headers = [];
  const seen = new Set();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    const lower = name.toLowerCase();
    if (lower === 'connection' || lower === 'keep-alive' || lower === 'proxy-connection') continue;
    if (lower === 'host') {
      headers.push('Host: 127.0.0.1:' + cdpPort);
      seen.add('host');
      continue;
    }
    headers.push(name + ': ' + value);
    seen.add(lower);
  }
  if (!seen.has('host')) headers.push('Host: 127.0.0.1:' + cdpPort);
  headers.push('Connection: close');
  return Buffer.from(request.method + ' ' + targetUrl + ' HTTP/' + request.httpVersion + '\r\n' + headers.join('\r\n') + '\r\n\r\n');
}

function serializeUpgradeRequest(request, head) {
  const headers = [];
  const seen = new Set();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name.toLowerCase() === 'host') {
      headers.push('Host: 127.0.0.1:' + cdpPort);
      seen.add('host');
      continue;
    }
    headers.push(name + ': ' + value);
    seen.add(name.toLowerCase());
  }
  if (!seen.has('host')) headers.push('Host: 127.0.0.1:' + cdpPort);
  return Buffer.concat([
    Buffer.from(request.method + ' ' + request.url + ' HTTP/' + request.httpVersion + '\r\n' + headers.join('\r\n') + '\r\n\r\n'),
    head
  ]);
}

function parseHttpResponseHead(buffer) {
  const marker = buffer.indexOf('\r\n\r\n');
  if (marker < 0) return undefined;
  const head = buffer.subarray(0, marker).toString('latin1');
  const lines = head.split('\r\n');
  const status = /^HTTP\/\d\.\d\s+(\d+)\s*(.*)$/.exec(lines.shift() || '');
  if (!status) throw new Error('Invalid HTTP response from Edge CDP');
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === 'connection') continue;
    headers[name] = value;
  }
  headers.connection = 'close';
  return {
    statusCode: Number.parseInt(status[1], 10),
    statusMessage: status[2],
    headers,
    body: buffer.subarray(marker + 4)
  };
}

function getContentLength(headers) {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-length');
  if (!entry) return Number.NaN;
  return Number.parseInt(String(entry[1]), 10);
}

function discoveryResponseCanBeBuffered(parsed) {
  const expectedBodyLength = getContentLength(parsed.headers);
  return Number.isFinite(expectedBodyLength) && parsed.body.length >= expectedBodyLength;
}

async function proxyHttpRequest(request, response) {
  const url = request.url || '/';
  if (new URL(url, 'http://127.0.0.1').pathname === '/bridgewright/check-endpoint.js') {
    serveCheckerScript(request, response);
    return;
  }
  if (['/bridgewright/health', '/bridgewright/diagnose'].includes(new URL(url, 'http://127.0.0.1').pathname)) {
    serveBridgewrightHealth(response);
    return;
  }
  const normalized = normalizeProfiledUrl(url);
  if (normalized.invalidProfile) {
    sendJson(response, 400, { error: 'Invalid Bridgewright profile name', profile: normalized.profile });
    return;
  }
  const isDiscovery = request.method === 'GET' && ['/json/version', '/json/list', '/json', '/json/protocol'].includes(normalized.routePath);
  const isManagement = (request.method === 'GET' && normalized.routePath === '/profiles')
    || (request.method === 'POST' && ['/close', '/remove'].includes(normalized.routePath));
  if (!isDiscovery && !isManagement) {
    sendJson(response, 404, { error: 'Unsupported CDP discovery path', path: url });
    return;
  }

  log('cdp http request ' + request.method + ' ' + normalized.facadeUrl);
  let tunnel;
  try {
    tunnel = await takeTunnel();
  } catch (error) {
    log('failed to acquire tunnel for ' + normalized.facadeUrl + ': ' + error.message);
    sendJson(response, 503, { error: 'Bridgewright local connector unavailable', detail: error.message });
    return;
  }

  const timer = setTimeout(() => {
    log('cdp http request timed out ' + normalized.facadeUrl);
    if (!response.headersSent) {
      sendJson(response, 503, { error: 'Timed out waiting for host browser CDP response', path: normalized.facadeUrl });
    } else {
      response.end();
    }
    tunnel.close();
  }, discoveryTimeoutMs);
  let pending = Buffer.alloc(0);
  let headersWritten = false;
  tunnel.onData((chunk) => {
    if (headersWritten) {
      response.write(chunk);
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    let parsed;
    try {
      parsed = parseHttpResponseHead(pending);
    } catch (error) {
      clearTimeout(timer);
      sendJson(response, 502, { error: error.message });
      tunnel.close();
      return;
    }
    if (!parsed) return;
    if (isDiscovery && parsed.statusCode >= 200 && parsed.statusCode < 300 && Number.isFinite(getContentLength(parsed.headers))) {
      if (!discoveryResponseCanBeBuffered(parsed)) return;
      try {
        const rewritten = normalized.routePath === '/json/protocol'
          ? parsed.body
          : Buffer.from(JSON.stringify(rewriteDiscoveryJson(normalized.profile, JSON.parse(parsed.body.toString('utf8'))), null, 2) + '\n');
        const headers = Object.fromEntries(Object.entries(parsed.headers).filter(([name]) => name.toLowerCase() !== 'content-length'));
        parsed = {
          ...parsed,
          headers: {
            ...headers,
            ...(normalized.routePath === '/json/protocol' ? {} : { 'content-type': 'application/json' }),
            'content-length': rewritten.length,
          },
          body: rewritten
        };
      } catch (error) {
        clearTimeout(timer);
        sendJson(response, 502, { error: 'Failed to rewrite CDP discovery response', detail: error.message });
        tunnel.close();
        return;
      }
      headersWritten = true;
      clearTimeout(timer);
      response.writeHead(parsed.statusCode, parsed.statusMessage, parsed.headers);
      response.end(parsed.body);
      tunnel.close();
      return;
    }
    headersWritten = true;
    response.writeHead(parsed.statusCode, parsed.statusMessage, parsed.headers);
    if (parsed.body.length > 0) response.write(parsed.body);
  });
  tunnel.onClose(() => {
    clearTimeout(timer);
    response.end();
  });
  response.once('close', () => {
    clearTimeout(timer);
    tunnel.close();
  });
  tunnel.send(serializeRequest(request, normalized.facadeUrl));
}

const cdpServer = http.createServer((request, response) => {
  void proxyHttpRequest(request, response);
});

cdpServer.on('upgrade', async (request, socket, head) => {
  const url = request.url || '/';
  const normalized = normalizeProfiledUrl(url);
  if (normalized.invalidProfile || !normalized.targetUrl.startsWith('/devtools/')) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  log('cdp websocket upgrade ' + normalized.facadeUrl);
  let tunnel;
  try {
    tunnel = await takeTunnel();
  } catch (error) {
    log('failed to acquire tunnel for websocket ' + url + ': ' + error.message);
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  tunnel.onData((chunk) => socket.write(chunk));
  socket.on('data', (chunk) => tunnel.send(chunk));
  socket.once('close', () => tunnel.close());
  socket.once('error', () => tunnel.close());
  tunnel.onClose(() => socket.destroy());
  tunnel.send(serializeUpgradeRequest(request, head));
});

let tunnelListening = false;
let cdpListening = false;

function maybeReady() {
  if (!tunnelListening || !cdpListening) return;
  writeWaitingForConnectorState();
  writeReady('running');
  log('ready cdp=' + cdpPort + ' tunnel=' + tunnelPort + ' pid=' + process.pid);
  console.log('BRIDGEWRIGHT_READY ' + JSON.stringify({ cdpPort, tunnelPort }));
}

function fatal(error) {
  const message = error && error.message ? error.message : String(error);
  log('fatal ' + message);
  writeState('error', { error: message });
  writeReady('error', { error: message });
  process.exit(1);
}

tunnelServer.on('error', fatal);
cdpServer.on('error', fatal);
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

log('starting helper cdp=' + cdpPort + ' tunnel=' + tunnelPort + ' pid=' + process.pid);
stopExistingHelpers();
tunnelServer.listen(tunnelPort, '127.0.0.1', () => {
  tunnelListening = true;
  log('tunnel server listening on ' + tunnelPort);
  maybeReady();
});
cdpServer.listen(cdpPort, '127.0.0.1', () => {
  cdpListening = true;
  log('cdp facade listening on ' + cdpPort);
  maybeReady();
});

function shutdown() {
  writeState('stopped');
  writeReady('stopped');
  for (const tunnel of idleTunnels) tunnel.close();
  tunnelServer.close();
  cdpServer.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
`;

export class BridgeManager implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private readonly output: vscode.OutputChannel;
  private readonly rootPath: string;
  private profilePath: string;
  private readonly logsPath: string;
  private readonly namedProfilesPath: string;
  private readonly statePath: string;
  private edgeProcess: childProcess.ChildProcess | undefined;
  private edgeCdp: CdpVersion | undefined;
  private edgeLaunch: Promise<CdpVersion> | undefined;
  private readonly namedProfileLaunches = new Map<string, Promise<EdgeRuntime>>();
  private readonly namedProfileCleanups = new Map<string, Promise<void>>();
  private readonly runtimes = new Map<string, EdgeRuntime>();
  private helperTerminal: vscode.Terminal | undefined;
  private remoteRuntimeDir: vscode.Uri | undefined;
  private connectorAbort: AbortController | undefined;
  private logStream: fs.WriteStream | undefined;
  private status: BridgeStatus = 'stopped';
  private state: BridgeState;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.rootPath = path.join(os.homedir(), '.bridgewright');
    this.profilePath = this.readProfilePath();
    this.logsPath = path.join(this.rootPath, 'logs');
    this.namedProfilesPath = path.join(this.rootPath, 'profiles');
    this.statePath = path.join(this.rootPath, 'state.json');
    this.state = this.createState('stopped');

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = 'bridgewright.start';
    this.statusBar.tooltip = 'Start Bridgewright local browser bridge';
    this.updateStatusBar();
    this.statusBar.show();

    this.output = vscode.window.createOutputChannel('Bridgewright');
  }

  public async start(): Promise<void> {
    if (this.status === 'running') {
      await this.copyEndpoint();
      return;
    }

    await this.ensureStorage();
    await this.cleanupNamedProfiles();
    this.openLog();
    this.output.show(true);
    this.setStatus('starting');
    this.log(`Starting Bridgewright bridge v${this.readExtensionVersion()}`);

    try {
      if (os.platform() !== 'win32') {
        throw new Error('Bridgewright must be started from Windows VS Code.');
      }

      if (!vscode.env.remoteName) {
        throw new Error('Open this command from a VS Code window connected to a Codespace.');
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        throw new Error('Open a Codespace workspace folder before starting Bridgewright.');
      }

      const port = this.readDefaultPort();
      const tunnelPort = port + this.readTunnelPortOffset();
      this.log(`Configuration: endpoint=127.0.0.1:${port} tunnel=127.0.0.1:${tunnelPort} profile="${this.profilePath}" connectorPool=${this.readConnectorPoolSize()}`);
      const remoteHelper = await this.startRemoteHelper(workspaceFolder, port, tunnelPort);
      await this.waitForRemoteHelper(remoteHelper);
      const tunnelUri = await this.resolveTunnelUri(tunnelPort);
      await this.startConnectorPool(tunnelUri);

      const endpoint = `http://127.0.0.1:${port}`;
      this.state = {
        status: 'running',
        endpoint,
        remotePort: port,
        tunnelPort,
        profilePath: this.profilePath,
        updatedAt: new Date().toISOString(),
      };
      await this.writeState(this.state);
      this.setStatus('running');
      vscode.window.showInformationMessage(`Bridgewright running at ${endpoint}`);
    } catch (error) {
      await this.stopProcesses(false);
      const message = this.errorMessage(error);
      this.log(`Start failed: ${message}`);
      this.state = this.createState('error', message);
      await this.writeState(this.state);
      this.setStatus('error');
      vscode.window.showErrorMessage(`Bridgewright failed: ${message}`);
    }
  }

  public async stop(): Promise<void> {
    this.log('Stopping Bridgewright bridge');
    await this.stopProcesses();
    this.state = this.createState('stopped');
    await this.writeState(this.state);
    this.setStatus('stopped');
    vscode.window.showInformationMessage('Bridgewright stopped');
  }

  public async showStatus(): Promise<void> {
    const detail = [
      `Status: ${this.state.status}`,
      `Endpoint: ${this.state.endpoint ?? 'none'}`,
      `Profile: ${this.profilePath}`,
      `Logs: ${this.logsPath}`,
      this.state.error ? `Error: ${this.state.error}` : undefined,
    ].filter(Boolean).join('\n');
    vscode.window.showInformationMessage(detail, { modal: true });
  }

  public async copyEndpoint(): Promise<void> {
    if (!this.state.endpoint) {
      vscode.window.showWarningMessage('Bridgewright is not running.');
      return;
    }

    await vscode.env.clipboard.writeText(this.state.endpoint);
    vscode.window.showInformationMessage(`Copied ${this.state.endpoint}`);
  }

  public async showLogs(): Promise<void> {
    await this.ensureStorage();
    this.log(`File logs directory: ${this.logsPath}`);
    this.output.show(true);
  }

  public dispose(): void {
    this.statusBar.dispose();
    this.output.dispose();
    this.closeLog();
    void this.stopProcesses();
  }

  private readDefaultPort(): number {
    return vscode.workspace.getConfiguration('bridgewright').get<number>('defaultRemotePort', 37373);
  }

  private readTunnelPortOffset(): number {
    return vscode.workspace.getConfiguration('bridgewright').get<number>('tunnelPortOffset', 1);
  }

  private readConnectorPoolSize(): number {
    return vscode.workspace.getConfiguration('bridgewright').get<number>('connectorPoolSize', 4);
  }

  private closeNamedProfilesOnDisconnect(): boolean {
    return vscode.workspace.getConfiguration('bridgewright').get<boolean>('closeNamedProfilesOnDisconnect', true);
  }

  private closeDefaultProfileOnDisconnect(): boolean {
    return vscode.workspace.getConfiguration('bridgewright').get<boolean>('closeDefaultProfileOnDisconnect', true);
  }

  private readExtensionVersion(): string {
    const version = this.context.extension?.packageJSON?.version;
    return typeof version === 'string' && version.length > 0 ? version : 'unknown';
  }

  private readProfilePath(): string {
    const configured = vscode.workspace.getConfiguration('bridgewright').get<string>('edgeUserDataDir', '').trim();
    if (configured.length > 0) {
      return configured;
    }
    if (vscode.workspace.getConfiguration('bridgewright').get<boolean>('useSystemEdgeUserDataDirByDefault', false)) {
      return path.join(os.homedir(), 'AppData\\Local\\Microsoft\\Edge\\User Data');
    }
    return path.join(os.homedir(), '.bridgewright', 'default-edge-user-data');
  }

  private async ensureStorage(): Promise<void> {
    await fs.promises.mkdir(this.profilePath, { recursive: true });
    await fs.promises.mkdir(this.logsPath, { recursive: true });
    await fs.promises.mkdir(this.namedProfilesPath, { recursive: true });
  }

  private resolveProfilePath(profile: string): string {
    if (profile === DEFAULT_PROFILE) {
      return this.profilePath;
    }
    if (!isValidProfileName(profile)) {
      throw new Error(`Invalid Bridgewright profile name: ${profile}`);
    }
    return path.join(this.namedProfilesPath, profile, 'edge-user-data');
  }

  private async cleanupNamedProfiles(): Promise<void> {
    await fs.promises.rm(this.namedProfilesPath, { recursive: true, force: true });
    await fs.promises.mkdir(this.namedProfilesPath, { recursive: true });
  }

  private async deleteNamedProfile(profile: string): Promise<void> {
    if (profile === DEFAULT_PROFILE) {
      throw new Error('The default Bridgewright profile cannot be removed.');
    }
    if (!isValidProfileName(profile)) {
      throw new Error(`Invalid Bridgewright profile name: ${profile}`);
    }
    const profilePath = path.join(this.namedProfilesPath, profile);
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.promises.rm(profilePath, { recursive: true, force: true });
        return;
      } catch (error) {
        lastError = error;
        await this.delay(200);
      }
    }
    throw lastError;
  }

  private async stopRuntime(runtime: EdgeRuntime): Promise<void> {
    const runtimeProcess = runtime.process;
    if (!runtimeProcess) {
      return;
    }
    if (runtimeProcess.exitCode !== null || runtimeProcess.signalCode !== null) {
      return;
    }
    if (!runtimeProcess.killed) {
      runtimeProcess.kill();
    }
    await Promise.race([
      new Promise<void>(resolve => runtimeProcess.once('exit', () => resolve())),
      this.delay(2_000),
    ]);
  }

  private async stopAndDeleteNamedProfile(profile: string): Promise<void> {
    if (profile === DEFAULT_PROFILE) {
      throw new Error('The default Bridgewright profile cannot be removed.');
    }
    const existingCleanup = this.namedProfileCleanups.get(profile);
    if (existingCleanup) {
      await existingCleanup;
      return;
    }
    const cleanup = (async () => {
      const runtime = this.runtimes.get(profile);
      if (runtime) {
        runtime.activeSessions = 0;
        this.runtimes.delete(profile);
        await this.stopRuntime(runtime);
      }
      await this.deleteNamedProfile(profile);
    })();
    this.namedProfileCleanups.set(profile, cleanup);
    try {
      await cleanup;
    } finally {
      if (this.namedProfileCleanups.get(profile) === cleanup) {
        this.namedProfileCleanups.delete(profile);
      }
    }
  }

  private async listProfiles(): Promise<Array<{ profile: string; running: boolean; durable: boolean }>> {
    const profiles = new Map<string, { profile: string; running: boolean; durable: boolean }>();
    profiles.set(DEFAULT_PROFILE, {
      profile: DEFAULT_PROFILE,
      running: this.runtimes.has(DEFAULT_PROFILE),
      durable: true,
    });
    for (const profile of this.runtimes.keys()) {
      if (profile !== DEFAULT_PROFILE) {
        profiles.set(profile, { profile, running: true, durable: false });
      }
    }
    try {
      const entries = await fs.promises.readdir(this.namedProfilesPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && isValidProfileName(entry.name) && entry.name !== DEFAULT_PROFILE) {
          profiles.set(entry.name, {
            profile: entry.name,
            running: this.runtimes.has(entry.name),
            durable: false,
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return [...profiles.values()].sort((left, right) => left.profile.localeCompare(right.profile));
  }

  private async tryHandleManagementRequest(tunnel: BridgeWebSocket, routed: RoutedPayload): Promise<boolean> {
    if (!routed.management) {
      return false;
    }
    try {
      if (routed.management.action === 'list') {
        tunnel.send(httpJsonResponse(200, { profiles: await this.listProfiles() }));
        return true;
      }
      const profile = routed.management.profile ?? DEFAULT_PROFILE;
      if (profile === DEFAULT_PROFILE) {
        tunnel.send(httpJsonResponse(400, { error: 'The default Bridgewright profile cannot be closed or removed.' }));
        return true;
      }
      await this.stopAndDeleteNamedProfile(profile);
      tunnel.send(httpJsonResponse(200, { profile, removed: true }));
      return true;
    } catch (error) {
      tunnel.send(httpJsonResponse(500, { error: this.errorMessage(error) }));
      return true;
    }
  }

  private openLog(): void {
    if (this.logStream) {
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logStream = fs.createWriteStream(path.join(this.logsPath, `${stamp}.log`), { flags: 'a' });
  }

  private closeLog(): void {
    this.logStream?.end();
    this.logStream = undefined;
  }

  private log(message: string): void {
    const line = `${new Date().toISOString()} ${message}`;
    this.output.appendLine(line);
    this.logStream?.write(line);
    this.logStream?.write('\n');
  }

  private findEdgePath(): string {
    const candidates = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      path.join(os.homedir(), 'AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'),
    ];

    const edgePath = candidates.find(candidate => fs.existsSync(candidate));
    if (!edgePath) {
      throw new Error('Microsoft Edge was not found in the standard install locations.');
    }

    return edgePath;
  }

  private assertProfileAvailable(profilePath: string): void {
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']
      .map(name => path.join(profilePath, name))
      .filter(candidate => fs.existsSync(candidate));

    if (lockFiles.length > 0) {
      throw new Error(`The automation profile appears to be in use: ${lockFiles.join(', ')}. Stop the existing bridge or close the automation Edge window.`);
    }
  }

  private connectWebSocketTunnel(tunnelUri: URL, signal: AbortSignal): Promise<BridgeWebSocket> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Connector stopped'));
        return;
      }

      const key = crypto.randomBytes(16).toString('base64');
      const transport = tunnelUri.protocol === 'wss:' ? https : http;
      const request = transport.request(tunnelUri, {
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key,
        },
      });

      const fail = (error: Error): void => {
        signal.removeEventListener('abort', onAbort);
        request.destroy();
        reject(error);
      };
      const onAbort = (): void => fail(new Error('Connector stopped'));
      signal.addEventListener('abort', onAbort, { once: true });
      request.once('error', fail);
      request.once('upgrade', (response, socket, head) => {
        signal.removeEventListener('abort', onAbort);
        if (response.statusCode !== 101) {
          socket.destroy();
          reject(new Error(`Tunnel WebSocket upgrade returned HTTP ${response.statusCode ?? 'unknown'}`));
          return;
        }
        const accepted = response.headers['sec-websocket-accept'];
        const expected = crypto
          .createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        if (accepted !== expected) {
          socket.destroy();
          reject(new Error('Tunnel WebSocket returned an invalid accept header'));
          return;
        }
        resolve(this.createClientWebSocket(socket, head));
      });
      request.end();
    });
  }

  private createClientWebSocket(socket: net.Socket, initialHead: Buffer): BridgeWebSocket {
    let buffer = initialHead;
    let closedResolver: () => void;
    let closed = false;
    const dataHandlers: Array<(payload: Buffer) => void> = [];
    const closedPromise = new Promise<void>(resolve => {
      closedResolver = resolve;
    });

    const close = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      socket.destroy();
      closedResolver();
    };

    const consume = (): void => {
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) {
            return;
          }
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) {
            return;
          }
          const bigLength = buffer.readBigUInt64BE(2);
          if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            close();
            return;
          }
          length = Number(bigLength);
          offset = 10;
        }
        const masked = (buffer[1] & 0x80) !== 0;
        const maskLength = masked ? 4 : 0;
        if (buffer.length < offset + maskLength + length) {
          return;
        }
        let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
        if (masked) {
          const mask = buffer.subarray(offset, offset + 4);
          payload = Buffer.from(payload);
          for (let index = 0; index < payload.length; index++) {
            payload[index] ^= mask[index % 4];
          }
        }
        buffer = buffer.subarray(offset + maskLength + length);
        if (opcode === 0x8) {
          close();
          return;
        }
        if (opcode === 0x2 || opcode === 0x1) {
          for (const handler of dataHandlers) {
            handler(payload);
          }
        }
      }
    };

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      consume();
    });
    socket.once('close', close);
    socket.once('error', close);
    consume();

    return {
      closed: closedPromise,
      send: (payload: Buffer): void => {
        if (closed) {
          return;
        }
        socket.write(encodeMaskedWebSocketFrame(payload));
      },
      close,
      onData: (handler: (payload: Buffer) => void): void => {
        dataHandlers.push(handler);
      },
    };
  }

  private async launchEdge(edgePath: string, profilePath: string): Promise<{ cdp: CdpVersion; port: number; process?: childProcess.ChildProcess }> {
    await fs.promises.mkdir(profilePath, { recursive: true });
    const existingPort = await this.tryReadDevToolsActivePort(profilePath);
    if (existingPort !== undefined) {
      const cdp = await this.tryGetLocalCdp(existingPort);
      if (cdp) {
        this.log(`Reusing existing Bridgewright Edge on local CDP port ${existingPort}`);
        return { cdp, port: existingPort };
      }
      this.log(`Ignoring stale DevToolsActivePort value ${existingPort}`);
    }

    const recovered = await this.tryRecoverExistingEdgeCdp(profilePath);
    if (recovered) {
      return recovered;
    }

    this.assertProfileAvailable(profilePath);
    await fs.promises.rm(path.join(profilePath, 'DevToolsActivePort'), { force: true });
    const args = [
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profilePath}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ];

    this.log(`Launching Edge: ${edgePath} ${args.join(' ')}`);
    const edgeProcess = childProcess.spawn(edgePath, args, {
      windowsHide: false,
      stdio: 'ignore',
    });

    edgeProcess.once('exit', (code, signal) => {
      this.log(`Edge exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    });

    const port = await this.waitForDevToolsActivePort(profilePath, edgeProcess);
    const cdp = await this.waitForLocalCdp(port);
    return { cdp, port, process: edgeProcess };
  }

  private async tryRecoverExistingEdgeCdp(profilePath: string): Promise<{ cdp: CdpVersion; port: number } | undefined> {
    const ports = await this.findListeningPortsForProfileOwner(profilePath);
    for (const port of ports) {
      const cdp = await this.tryGetLocalCdp(port);
      if (cdp) {
        this.log(`Recovered existing Bridgewright Edge on local CDP port ${port}`);
        return { cdp, port };
      }
      this.log(`Existing Bridgewright Edge candidate port ${port} was not CDP-ready`);
    }
    return undefined;
  }

  private findListeningPortsForProfileOwner(profilePath: string): Promise<number[]> {
    if (os.platform() !== 'win32') {
      return Promise.resolve([]);
    }
    const profileLiteral = profilePath.replace(/'/g, "''");
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$profile = '${profileLiteral}'
$owners = Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" |
  Where-Object { $_.CommandLine -like "*$profile*" -and $_.CommandLine -notlike "*--type=*" } |
  Select-Object -ExpandProperty ProcessId
$ports = foreach ($owner in $owners) {
  Get-NetTCPConnection -State Listen -OwningProcess $owner -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' } |
    Select-Object -ExpandProperty LocalPort
}
@($ports | Sort-Object -Unique) | ConvertTo-Json
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return new Promise(resolve => {
      childProcess.execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', encoded], {
        timeout: 5_000,
        windowsHide: true,
      }, (error, stdout) => {
        if (error) {
          this.log(`Could not inspect existing Bridgewright Edge ports: ${this.errorMessage(error)}`);
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim() || '[]') as unknown;
          const values = Array.isArray(parsed) ? parsed : [parsed];
          resolve(values.filter((value): value is number => Number.isInteger(value) && value > 0 && value <= 65535));
        } catch (parseError) {
          this.log(`Could not parse existing Bridgewright Edge ports: ${this.errorMessage(parseError)}`);
          resolve([]);
        }
      });
    });
  }

  private async tryReadDevToolsActivePort(profilePath: string): Promise<number | undefined> {
    try {
      const [line] = (await fs.promises.readFile(path.join(profilePath, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/);
      const port = Number.parseInt(line ?? '', 10);
      return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  private async tryGetLocalCdp(port: number): Promise<CdpVersion | undefined> {
    try {
      const body = await this.httpGet(`http://127.0.0.1:${port}/json/version`);
      const parsed = JSON.parse(body) as CdpVersion;
      return parsed.webSocketDebuggerUrl ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async waitForDevToolsActivePort(profilePath: string, edgeProcess: childProcess.ChildProcess): Promise<number> {
    const activePortPath = path.join(profilePath, 'DevToolsActivePort');
    const deadline = Date.now() + 25_000;
    let lastError: string | undefined;

    while (Date.now() < deadline) {
      if (edgeProcess.exitCode !== null || edgeProcess.signalCode !== null) {
        throw new Error(`Edge exited before writing DevToolsActivePort. code=${edgeProcess.exitCode ?? 'null'} signal=${edgeProcess.signalCode ?? 'null'}`);
      }
      try {
        const [line] = (await fs.promises.readFile(activePortPath, 'utf8')).split(/\r?\n/);
        const port = Number.parseInt(line ?? '', 10);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          this.log(`Edge selected local CDP port ${port}`);
          return port;
        }
        lastError = `DevToolsActivePort did not contain a valid port: ${line ?? ''}`;
      } catch (error) {
        lastError = this.errorMessage(error);
      }
      await this.delay(250);
    }

    throw new Error(`Edge did not write DevToolsActivePort under ${profilePath}. ${lastError ?? ''}`.trim());
  }

  private async waitForLocalCdp(port: number): Promise<CdpVersion> {
    const deadline = Date.now() + 25_000;
    let lastError: string | undefined;

    while (Date.now() < deadline) {
      try {
        const body = await this.httpGet(`http://127.0.0.1:${port}/json/version`);
        const parsed = JSON.parse(body) as CdpVersion;
        if (parsed.webSocketDebuggerUrl) {
          this.log(`Local CDP ready on ${port}: ${parsed.Browser ?? 'unknown browser'}`);
          return parsed;
        }
        lastError = 'CDP response did not include webSocketDebuggerUrl';
      } catch (error) {
        lastError = this.errorMessage(error);
      }
      await this.delay(500);
    }

    throw new Error(`Edge CDP did not become ready on 127.0.0.1:${port}. ${lastError ?? ''}`.trim());
  }

  private async startRemoteHelper(workspaceFolder: vscode.WorkspaceFolder, port: number, tunnelPort: number): Promise<RemoteHelper> {
    const runtimeDir = workspaceFolder.uri.with({
      path: resolveRemoteRuntimePath(workspaceFolder.uri.path),
    });
    this.remoteRuntimeDir = runtimeDir;
    await this.deleteRemoteDirectoryIfExists(vscode.Uri.joinPath(workspaceFolder.uri, '.bridgewright-runtime'));
    await this.deleteRemoteDirectoryIfExists(runtimeDir);
    const helperUri = vscode.Uri.joinPath(runtimeDir, 'bridgewright-helper.cjs');
    const checkerUri = vscode.Uri.joinPath(runtimeDir, 'bridgewright-check-endpoint.js');
    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const readyUri = vscode.Uri.joinPath(runtimeDir, `ready-${runId}.json`);
    const logUri = vscode.Uri.joinPath(runtimeDir, `helper-${runId}.log`);
    const launcherUri = vscode.Uri.joinPath(runtimeDir, `launch-${runId}.sh`);
    await vscode.workspace.fs.createDirectory(runtimeDir);
    await vscode.workspace.fs.writeFile(helperUri, Buffer.from(HELPER_SCRIPT, 'utf8'));
    await vscode.workspace.fs.writeFile(checkerUri, await this.readBundledCheckerScript());
    await vscode.workspace.fs.writeFile(launcherUri, Buffer.from(createRemoteLauncherScript({
      helperPath: this.remoteTerminalPath(helperUri),
      readyPath: this.remoteTerminalPath(readyUri),
      logPath: this.remoteTerminalPath(logUri),
      cdpPort: port,
      tunnelPort,
      connectorTimeoutMs: 3000,
      discoveryTimeoutMs: 20000,
    }), 'utf8'));

    this.helperTerminal?.dispose();
    this.log(`Writing remote helper to ${helperUri.toString()}`);
    this.log(`Writing remote diagnostics checker to ${checkerUri.toString()}`);
    this.log(`Writing remote launcher to ${launcherUri.toString()}`);
    this.helperTerminal = vscode.window.createTerminal({
      name: 'Bridgewright Helper',
      cwd: workspaceFolder.uri,
      hideFromUser: true,
    });
    const command = `sh ${remoteShellQuote(this.remoteTerminalPath(launcherUri))}`;
    this.helperTerminal.sendText(command);
    this.log(`Sent remote helper command: ${command}`);
    this.log(`Started remote helper ${this.remoteTerminalPath(helperUri)}`);
    this.log(`Remote helper ready file: ${readyUri.toString()}`);
    this.log(`Remote helper workspace log: ${logUri.toString()}`);
    this.log(`Remote diagnostics command: curl -fsSL http://127.0.0.1:${port}/bridgewright/check-endpoint.js | node - --diagnose --timeout-ms 20000`);
    return { readyUri, logUri };
  }

  private async readBundledCheckerScript(): Promise<Uint8Array> {
    const checkerUri = vscode.Uri.joinPath(this.context.extensionUri, '.claude', 'skills', 'bridgewright', 'scripts', 'check-endpoint.js');
    return vscode.workspace.fs.readFile(checkerUri);
  }

  private async resolveTunnelUri(remoteTunnelPort: number): Promise<URL> {
    const uri = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${remoteTunnelPort}/bridgewright-tunnel`));
    const tunnelUri = new URL(uri.toString());
    this.log(`Resolved remote tunnel ${remoteTunnelPort} to HTTP upgrade URI ${tunnelUri.toString()}`);
    return tunnelUri;
  }

  private async startConnectorPool(tunnelUri: URL): Promise<void> {
    this.connectorAbort?.abort();
    const abort = new AbortController();
    this.connectorAbort = abort;
    const poolSize = this.readConnectorPoolSize();
    let armed = false;
    let resolveFirstArmed!: () => void;
    const firstArmed = new Promise<void>(resolve => {
      resolveFirstArmed = resolve;
    });
    const onArmed = (): void => {
      if (!armed) {
        armed = true;
        resolveFirstArmed();
      }
    };
    for (let index = 0; index < poolSize; index++) {
      void this.runConnectorLoop(tunnelUri, abort.signal, index + 1, onArmed);
    }
    this.log(`Started ${poolSize} connector loop(s)`);
    await this.withTimeout(firstArmed, 10_000, 'No Bridgewright connector armed within 10000ms');
  }

  private async runConnectorLoop(tunnelUri: URL, signal: AbortSignal, connectorId: number, onArmed: () => void): Promise<void> {
    while (!signal.aborted) {
      let pairedRuntime: EdgeRuntime | undefined;
      let tunnel: BridgeWebSocket | undefined;
      let edge: net.Socket | undefined;
      try {
        this.log(`Connector ${connectorId} connecting to tunnel ${tunnelUri.toString()}`);
        tunnel = await this.connectWebSocketTunnel(tunnelUri, signal);
        this.log(`Connector ${connectorId} armed`);
        onArmed();
        const pendingPayloads: Buffer[] = [];
        let firstPayloadResolver: (() => void) | undefined;
        tunnel.onData(chunk => {
          if (edge && !edge.destroyed) {
            edge.write(chunk);
            return;
          }
          pendingPayloads.push(chunk);
          firstPayloadResolver?.();
          firstPayloadResolver = undefined;
        });

        await Promise.race([
          new Promise<void>(resolve => {
            firstPayloadResolver = resolve;
          }),
          tunnel.closed.then(() => {
            throw new Error('Tunnel closed before a CDP client sent data');
          }),
        ]);

        const routed = parseRoutedPayload(pendingPayloads[0]);
        if (await this.tryHandleManagementRequest(tunnel, routed)) {
          tunnel.close();
          continue;
        }
        pendingPayloads[0] = routed.payload;
        const runtime = await this.ensureEdgeStarted(routed.profile);
        this.retainRuntimeSession(runtime);
        pairedRuntime = runtime;
        edge = await this.connectSocket(runtime.port, signal);
        const activeTunnel = tunnel;
        this.state = {
          ...this.state,
          browser: runtime.cdp.Browser,
          localPort: runtime.port,
          profilePath: runtime.profilePath,
          updatedAt: new Date().toISOString(),
        };
        await this.writeState(this.state);
        this.log(`Connector ${connectorId} paired ${tunnelUri.toString()} to local Edge ${runtime.port} profile=${routed.profile}`);
        edge.on('data', chunk => activeTunnel.send(Buffer.from(chunk)));
        edge.once('error', error => {
          this.log(`Connector ${connectorId} Edge socket closed with error: ${this.errorMessage(error)}`);
        });
        for (const payload of pendingPayloads.splice(0)) {
          edge.write(payload);
        }
        await Promise.race([
          tunnel.closed,
          this.onceClose(edge),
        ]);
        this.log(`Connector ${connectorId} session closed`);
        tunnel.close();
        edge.destroy();
      } catch (error) {
        if (!signal.aborted) {
          this.log(`Connector ${connectorId} retry: ${this.errorMessage(error)}`);
          if (tunnel) {
            tunnel.send(httpJsonResponse(503, { error: this.errorMessage(error) }));
            tunnel.close();
          }
          edge?.destroy();
          await this.waitForAbortOrTimeout(signal, 500);
        }
      } finally {
        if (pairedRuntime) {
          await this.releaseRuntimeSession(pairedRuntime, connectorId);
        }
      }
    }
  }

  private retainRuntimeSession(runtime: EdgeRuntime): void {
    runtime.activeSessions += 1;
  }

  private async releaseRuntimeSession(runtime: EdgeRuntime, connectorId: number): Promise<void> {
    runtime.activeSessions = Math.max(0, runtime.activeSessions - 1);
    const isDefaultProfile = runtime.profile === DEFAULT_PROFILE;
    const shouldCloseOnDisconnect = isDefaultProfile
      ? this.closeDefaultProfileOnDisconnect()
      : this.closeNamedProfilesOnDisconnect();
    if (!shouldCloseOnDisconnect) {
      return;
    }
    if (runtime.activeSessions > 0 || this.runtimes.get(runtime.profile) !== runtime) {
      return;
    }

    await this.delay(PROFILE_DISCONNECT_GRACE_MS);
    if (runtime.activeSessions > 0 || this.runtimes.get(runtime.profile) !== runtime) {
      return;
    }

    if (isDefaultProfile) {
      this.log(`Connector ${connectorId} closed last session for default profile; stopping Edge runtime`);
      await this.stopRuntime(runtime);
      if (this.runtimes.get(runtime.profile) === runtime) {
        this.runtimes.delete(runtime.profile);
      }
      if (runtime.process && this.edgeProcess === runtime.process) {
        this.edgeProcess = undefined;
        this.edgeCdp = undefined;
      }
      return;
    }

    this.runtimes.delete(runtime.profile);
    this.log(`Connector ${connectorId} closed last session for profile=${runtime.profile}; stopping named Edge runtime`);
    const cleanup = (async () => {
      await this.stopRuntime(runtime);
      await this.deleteNamedProfile(runtime.profile);
    })();
    this.namedProfileCleanups.set(runtime.profile, cleanup);
    try {
      await cleanup;
    } finally {
      if (this.namedProfileCleanups.get(runtime.profile) === cleanup) {
        this.namedProfileCleanups.delete(runtime.profile);
      }
    }
  }

  private connectSocket(port: number, signal: AbortSignal): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Connector stopped'));
        return;
      }
      const socket = net.connect({ host: '127.0.0.1', port });
      const cleanup = (): void => {
        socket.removeListener('connect', onConnect);
        socket.removeListener('error', onError);
        signal.removeEventListener('abort', onAbort);
      };
      const onConnect = (): void => {
        cleanup();
        resolve(socket);
      };
      const onError = (error: Error): void => {
        cleanup();
        socket.destroy();
        reject(error);
      };
      const onAbort = (): void => {
        cleanup();
        socket.destroy();
        reject(new Error('Connector stopped'));
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private onceClose(socket: net.Socket): Promise<void> {
    return new Promise(resolve => socket.once('close', () => resolve()));
  }

  private withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      operation.then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private waitForAbortOrTimeout(signal: AbortSignal, timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
      if (signal.aborted) {
        resolve();
        return;
      }
      let timer: NodeJS.Timeout;
      const onAbort = (): void => cleanup();
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      timer = setTimeout(cleanup, timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async ensureEdgeStarted(profile: string): Promise<EdgeRuntime> {
    const cleanup = this.namedProfileCleanups.get(profile);
    if (cleanup) {
      await cleanup;
    }

    const existing = this.runtimes.get(profile);
    if (existing) {
      return existing;
    }

    if (profile !== DEFAULT_PROFILE) {
      const pendingLaunch = this.namedProfileLaunches.get(profile);
      if (pendingLaunch) {
        return pendingLaunch;
      }
    }

    if (profile === DEFAULT_PROFILE && this.edgeLaunch) {
      await this.edgeLaunch;
      const runtime = this.runtimes.get(profile);
      if (runtime) {
        return runtime;
      }
    }

    const launch = (async () => {
      const profilePath = this.resolveProfilePath(profile);
      const launched = await this.launchEdge(this.findEdgePath(), profilePath);
      const runtime: EdgeRuntime = {
        profile,
        port: launched.port,
        profilePath,
        cdp: launched.cdp,
        process: launched.process,
        activeSessions: 0,
      };
      launched.process?.once('exit', () => {
        if (this.runtimes.get(profile)?.process === launched.process) {
          this.runtimes.delete(profile);
          if (profile === DEFAULT_PROFILE) {
            this.edgeProcess = undefined;
            this.edgeCdp = undefined;
          }
          if (this.status === 'running') {
            this.state = {
              ...this.state,
              browser: undefined,
              localPort: undefined,
              updatedAt: new Date().toISOString(),
            };
            void this.writeState(this.state);
          }
          if (profile !== DEFAULT_PROFILE) {
            void this.deleteNamedProfile(profile);
          }
        }
      });
      this.runtimes.set(profile, runtime);
      if (profile === DEFAULT_PROFILE) {
        this.edgeProcess = runtime.process;
        this.edgeCdp = runtime.cdp;
      }
      return runtime;
    })();

    if (profile === DEFAULT_PROFILE) {
      this.edgeLaunch = launch.then(runtime => runtime.cdp);
      this.edgeLaunch.catch(() => undefined);
    } else {
      this.namedProfileLaunches.set(profile, launch);
    }
    try {
      return await launch;
    } finally {
      if (profile === DEFAULT_PROFILE) {
        this.edgeLaunch = undefined;
      } else if (this.namedProfileLaunches.get(profile) === launch) {
        this.namedProfileLaunches.delete(profile);
      }
    }
  }

  private async waitForRemoteHelper(helper: RemoteHelper): Promise<void> {
    const deadline = Date.now() + 25_000;
    let lastError: string | undefined;
    let nextProgressLog = 0;
    while (Date.now() < deadline) {
      try {
        const body = await this.readRemoteText(helper.readyUri);
        const parsed = JSON.parse(body) as { readonly status?: string; readonly cdpPort?: number; readonly tunnelPort?: number; readonly error?: string };
        if (parsed.status === 'running') {
          this.log(`Remote helper ready: cdp=${parsed.cdpPort ?? 'unknown'} tunnel=${parsed.tunnelPort ?? 'unknown'}`);
          return;
        }
        if (parsed.status === 'error') {
          const helperLog = await this.readRemoteTextIfExists(helper.logUri);
          throw new RemoteHelperError(`Remote helper failed: ${parsed.error ?? 'unknown error'}${helperLog ? `\n${helperLog}` : ''}`);
        }
        if (parsed.status === 'stopped') {
          const helperLog = await this.readRemoteTextIfExists(helper.logUri);
          throw new RemoteHelperError(`Remote helper stopped before becoming ready${helperLog ? `\n${helperLog}` : ''}`);
        }
        lastError = `Remote helper ready file status was ${parsed.status ?? 'missing'}`;
      } catch (error) {
        lastError = this.errorMessage(error);
        if (error instanceof RemoteHelperError) {
          throw error;
        }
      }
      if (Date.now() >= nextProgressLog) {
        this.log(`Waiting for remote helper ready file ${helper.readyUri.toString()}: ${lastError ?? 'not written yet'}`);
        const helperLog = await this.readRemoteTextIfExists(helper.logUri);
        if (helperLog) {
          this.log(`Remote helper log so far:\n${helperLog.trimEnd()}`);
        }
        nextProgressLog = Date.now() + 2_000;
      }
      await this.delay(500);
    }
    const helperLog = await this.readRemoteTextIfExists(helper.logUri);
    throw new Error(`Codespace helper did not write ready state. ${lastError ?? ''}${helperLog ? `\n${helperLog}` : ''}`.trim());
  }

  private async deleteRemoteFileIfExists(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.delete(uri);
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError)) {
        this.log(`Could not delete remote file ${uri.toString()}: ${this.errorMessage(error)}`);
      }
    }
  }

  private async readRemoteText(uri: vscode.Uri): Promise<string> {
    const data = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(data).toString('utf8');
  }

  private async readRemoteTextIfExists(uri: vscode.Uri): Promise<string | undefined> {
    try {
      return await this.readRemoteText(uri);
    } catch {
      return undefined;
    }
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const transport = url.startsWith('https:') ? https : http;
      const request = transport.get(url, { timeout: 2_000 }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
        });
        response.on('end', () => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error(`HTTP ${response.statusCode ?? 'unknown'} from ${url}`));
          }
        });
      });
      request.on('timeout', () => {
        request.destroy(new Error(`Timed out fetching ${url}`));
      });
      request.on('error', reject);
    });
  }

  private async stopProcesses(cleanRemoteRuntime = true): Promise<void> {
    this.connectorAbort?.abort();
    this.connectorAbort = undefined;
    this.helperTerminal?.dispose();
    this.helperTerminal = undefined;
    const remoteRuntimeDir = this.remoteRuntimeDir;
    this.remoteRuntimeDir = undefined;

    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    const edge = this.edgeProcess;
    this.edgeProcess = undefined;
    this.edgeCdp = undefined;
    this.edgeLaunch = undefined;
    await Promise.allSettled(runtimes.map(runtime => this.stopRuntime(runtime)));
    if (edge && !edge.killed && !runtimes.some(runtime => runtime.process === edge)) {
      edge.kill();
    }

    await this.cleanupNamedProfiles();
    if (cleanRemoteRuntime && remoteRuntimeDir) {
      await this.deleteRemoteDirectoryIfExists(remoteRuntimeDir);
    }
  }

  private async deleteRemoteDirectoryIfExists(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
    } catch (error) {
      if (this.isMissingRemoteEntry(error)) {
        return;
      }
      throw error;
    }
  }

  private async writeState(state: BridgeState): Promise<void> {
    await this.ensureStorage();
    await fs.promises.writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  private createState(status: BridgeStatus, error?: string): BridgeState {
    return {
      status,
      profilePath: this.profilePath,
      updatedAt: new Date().toISOString(),
      error,
    };
  }

  private setStatus(status: BridgeStatus): void {
    this.status = status;
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    switch (this.status) {
      case 'starting':
        this.statusBar.text = '$(sync~spin) Bridgewright';
        this.statusBar.tooltip = 'Starting Bridgewright local browser bridge';
        this.statusBar.command = undefined;
        break;
      case 'running':
        this.statusBar.text = `$(debug-stop) Bridgewright: ${this.state.remotePort ?? ''}`;
        this.statusBar.tooltip = `Stop Bridgewright bridge at ${this.state.endpoint ?? 'unknown endpoint'}`;
        this.statusBar.command = 'bridgewright.stop';
        break;
      case 'error':
        this.statusBar.text = '$(warning) Bridgewright';
        this.statusBar.tooltip = this.state.error ?? 'Bridgewright bridge failed';
        this.statusBar.command = 'bridgewright.start';
        break;
      case 'stopped':
      default:
        this.statusBar.text = '$(debug-start) Bridgewright';
        this.statusBar.tooltip = 'Start Bridgewright local browser bridge';
        this.statusBar.command = 'bridgewright.start';
        break;
    }
  }

  private remoteTerminalPath(uri: vscode.Uri): string {
    return uri.path;
  }

  private isMissingRemoteEntry(error: unknown): boolean {
    const message = this.errorMessage(error);
    return /FileNotFound|EntryNotFound|ENOENT|not found|nonexistent|does not exist/i.test(message);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
