import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createRemoteLauncherScript, remoteShellQuote } from './launcher';
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
const discoveryTimeoutMs = Number.parseInt(args.get('--discovery-timeout-ms') || '5000', 10);
const replaceExisting = args.has('--replace-existing');
const readyFile = args.get('--ready-file');
const runtimeLog = args.get('--runtime-log');
const root = path.join(os.homedir(), '.bridgewright');
const logs = path.join(root, 'logs');
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
  let stopped = 0;
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
        stopped += 1;
      }
    } catch {
      // Process disappeared or is not readable.
    }
  }
  if (stopped > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
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
  });
  if (waiters.length > 0) {
    const waiter = waiters.shift();
    clearTimeout(waiter.timer);
    waiter(tunnel);
  } else {
    idleTunnels.push(tunnel);
  }
}

function takeTunnel(timeoutMs = discoveryTimeoutMs) {
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

function serializeRequest(request) {
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
  return Buffer.from(request.method + ' ' + request.url + ' HTTP/' + request.httpVersion + '\r\n' + headers.join('\r\n') + '\r\n\r\n');
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

async function proxyHttpRequest(request, response) {
  const url = request.url || '/';
  if (request.method !== 'GET' || !['/json/version', '/json/list', '/json', '/json/protocol'].includes(url)) {
    sendJson(response, 404, { error: 'Unsupported CDP discovery path', path: url });
    return;
  }

  log('cdp http request ' + request.method + ' ' + url);
  let tunnel;
  try {
    tunnel = await takeTunnel();
  } catch (error) {
    log('failed to acquire tunnel for ' + url + ': ' + error.message);
    sendJson(response, 503, { error: 'Bridgewright local connector unavailable', detail: error.message });
    return;
  }

  const timer = setTimeout(() => {
    log('cdp http request timed out ' + url);
    if (!response.headersSent) {
      sendJson(response, 503, { error: 'Timed out waiting for host browser CDP response', path: url });
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
  tunnel.send(serializeRequest(request));
}

const cdpServer = http.createServer((request, response) => {
  void proxyHttpRequest(request, response);
});

cdpServer.on('upgrade', async (request, socket, head) => {
  const url = request.url || '/';
  if (!url.startsWith('/devtools/')) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  log('cdp websocket upgrade ' + url);
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
  writeState('running');
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
  private readonly statePath: string;
  private edgeProcess: childProcess.ChildProcess | undefined;
  private edgeCdp: CdpVersion | undefined;
  private edgeLaunch: Promise<CdpVersion> | undefined;
  private helperTerminal: vscode.Terminal | undefined;
  private connectorAbort: AbortController | undefined;
  private logStream: fs.WriteStream | undefined;
  private status: BridgeStatus = 'stopped';
  private state: BridgeState;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.rootPath = path.join(os.homedir(), '.bridgewright');
    this.profilePath = this.readProfilePath();
    this.logsPath = path.join(this.rootPath, 'logs');
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
    this.openLog();
    this.output.show(true);
    this.setStatus('starting');
    this.log('Starting Bridgewright bridge');

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
      await this.assertPortFree(port);
      const remoteHelper = await this.startRemoteHelper(workspaceFolder, port, tunnelPort);
      await this.waitForRemoteHelper(remoteHelper);
      const tunnelUri = await this.resolveTunnelUri(tunnelPort);
      this.startConnectorPool(tunnelUri, port);

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
      await vscode.env.clipboard.writeText(endpoint);
      vscode.window.showInformationMessage(`Bridgewright running at ${endpoint}`);
    } catch (error) {
      await this.stopProcesses();
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

  private readProfilePath(): string {
    const configured = vscode.workspace.getConfiguration('bridgewright').get<string>('edgeUserDataDir', '').trim();
    if (configured.length > 0) {
      return configured;
    }
    return path.join(os.homedir(), 'AppData\\Local\\Microsoft\\Edge\\User Data');
  }

  private async ensureStorage(): Promise<void> {
    await fs.promises.mkdir(this.profilePath, { recursive: true });
    await fs.promises.mkdir(this.logsPath, { recursive: true });
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

  private assertProfileAvailable(): void {
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket']
      .map(name => path.join(this.profilePath, name))
      .filter(candidate => fs.existsSync(candidate));

    if (lockFiles.length > 0) {
      throw new Error(`The automation profile appears to be in use: ${lockFiles.join(', ')}. Stop the existing bridge or close the automation Edge window.`);
    }
  }

  private async assertPortFree(port: number): Promise<void> {
    if (!(await this.isPortFree(port))) {
      throw new Error(`Local port ${port} is already in use. Bridgewright v0 requires the product port to be free on Windows and in the Codespace.`);
    }
  }

  private isPortFree(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
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

  private async launchEdge(edgePath: string, port: number): Promise<CdpVersion> {
    const args = [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${this.profilePath}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ];

    this.log(`Launching Edge: ${edgePath} ${args.join(' ')}`);
    this.edgeProcess = childProcess.spawn(edgePath, args, {
      windowsHide: false,
      stdio: 'ignore',
    });

    this.edgeProcess.once('exit', (code, signal) => {
      this.log(`Edge exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      this.edgeProcess = undefined;
      this.edgeCdp = undefined;
      if (this.status === 'running') {
        this.state = {
          ...this.state,
          browser: undefined,
          localPort: undefined,
          updatedAt: new Date().toISOString(),
        };
        void this.writeState(this.state);
      }
    });

    return this.waitForLocalCdp(port);
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
    const runtimeDir = vscode.Uri.joinPath(workspaceFolder.uri, '.bridgewright-runtime');
    const helperUri = vscode.Uri.joinPath(runtimeDir, 'bridgewright-helper.js');
    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const readyUri = vscode.Uri.joinPath(runtimeDir, `ready-${runId}.json`);
    const logUri = vscode.Uri.joinPath(runtimeDir, `helper-${runId}.log`);
    const launcherUri = vscode.Uri.joinPath(runtimeDir, `launch-${runId}.sh`);
    await vscode.workspace.fs.createDirectory(runtimeDir);
    await vscode.workspace.fs.writeFile(helperUri, Buffer.from(HELPER_SCRIPT, 'utf8'));
    await vscode.workspace.fs.writeFile(launcherUri, Buffer.from(createRemoteLauncherScript({
      helperPath: this.remoteTerminalPath(helperUri),
      readyPath: this.remoteTerminalPath(readyUri),
      logPath: this.remoteTerminalPath(logUri),
      cdpPort: port,
      tunnelPort,
    }), 'utf8'));

    this.helperTerminal?.dispose();
    this.log(`Writing remote helper to ${helperUri.toString()}`);
    this.log(`Writing remote launcher to ${launcherUri.toString()}`);
    this.helperTerminal = vscode.window.createTerminal({
      name: 'Bridgewright Helper',
      cwd: workspaceFolder.uri,
      hideFromUser: false,
    });
    const command = `sh ${remoteShellQuote(this.remoteTerminalPath(launcherUri))}`;
    this.helperTerminal.sendText(command);
    this.helperTerminal.show(false);
    this.log(`Sent remote helper command: ${command}`);
    this.log(`Started remote helper ${this.remoteTerminalPath(helperUri)}`);
    this.log(`Remote helper ready file: ${readyUri.toString()}`);
    this.log(`Remote helper workspace log: ${logUri.toString()}`);
    return { readyUri, logUri };
  }

  private async resolveTunnelUri(remoteTunnelPort: number): Promise<URL> {
    const uri = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${remoteTunnelPort}/bridgewright-tunnel`));
    const tunnelUri = new URL(uri.toString());
    this.log(`Resolved remote tunnel ${remoteTunnelPort} to HTTP upgrade URI ${tunnelUri.toString()}`);
    return tunnelUri;
  }

  private startConnectorPool(tunnelUri: URL, edgePort: number): void {
    this.connectorAbort?.abort();
    const abort = new AbortController();
    this.connectorAbort = abort;
    const poolSize = this.readConnectorPoolSize();
    for (let index = 0; index < poolSize; index++) {
      void this.runConnectorLoop(tunnelUri, edgePort, abort.signal, index + 1);
    }
    this.log(`Started ${poolSize} connector loop(s)`);
  }

  private async runConnectorLoop(tunnelUri: URL, edgePort: number, signal: AbortSignal, connectorId: number): Promise<void> {
    while (!signal.aborted) {
      try {
        this.log(`Connector ${connectorId} connecting to tunnel ${tunnelUri.toString()}`);
        const tunnel = await this.connectWebSocketTunnel(tunnelUri, signal);
        this.log(`Connector ${connectorId} armed`);
        const pendingPayloads: Buffer[] = [];
        let firstPayloadResolver: (() => void) | undefined;
        let edge: net.Socket | undefined;
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

        const cdp = await this.ensureEdgeStarted(edgePort);
        edge = await this.connectSocket(edgePort, signal);
        this.state = {
          ...this.state,
          browser: cdp.Browser,
          localPort: edgePort,
          profilePath: this.profilePath,
          updatedAt: new Date().toISOString(),
        };
        await this.writeState(this.state);
        this.log(`Connector ${connectorId} paired ${tunnelUri.toString()} to local Edge ${edgePort}`);
        edge.on('data', chunk => tunnel.send(Buffer.from(chunk)));
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
          await this.delay(500);
        }
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

  private async ensureEdgeStarted(port: number): Promise<CdpVersion> {
    if (this.edgeCdp) {
      return this.edgeCdp;
    }
    if (this.edgeLaunch) {
      return this.edgeLaunch;
    }
    if (this.edgeProcess) {
      this.edgeCdp = await this.waitForLocalCdp(port);
      return this.edgeCdp;
    }
    this.edgeLaunch = (async () => {
      this.assertProfileAvailable();
      const cdp = await this.launchEdge(this.findEdgePath(), port);
      this.edgeCdp = cdp;
      return cdp;
    })();
    try {
      return await this.edgeLaunch;
    } finally {
      this.edgeLaunch = undefined;
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

  private async stopProcesses(): Promise<void> {
    this.connectorAbort?.abort();
    this.connectorAbort = undefined;
    this.helperTerminal?.dispose();
    this.helperTerminal = undefined;

    const edge = this.edgeProcess;
    this.edgeProcess = undefined;
    this.edgeCdp = undefined;
    this.edgeLaunch = undefined;
    if (edge && !edge.killed) {
      edge.kill();
    }

    await this.delay(250);
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

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
