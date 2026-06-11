#!/usr/bin/env node
/*
 * Checks whether the Bridgewright CDP endpoint is reachable from inside
 * a Codespace. Uses only Node.js built-ins so it works in fresh agent sessions.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:37373';
const STATE_FILE = path.join(os.homedir(), '.bridgewright', 'endpoint.json');

const USAGE = `
Usage:
  node .claude/skills/bridgewright/scripts/check-endpoint.js [--endpoint <url>] [--state-file <path>] [--timeout-ms <ms>] [--playwright] [--diagnose]

Checks /json/version, /json/version/, and /json/list for the Bridgewright CDP endpoint.
Use --playwright to also verify chromium.connectOverCDP.
Use --diagnose to include Bridgewright health and, when Playwright is available, a non-mutating browser context/page/frame snapshot.

Output:
  JSON only on stdout.

Exit codes:
  0  endpoint is healthy
  1  endpoint is missing or unhealthy
  2  invalid arguments
`;

function parseArgs(argv) {
  const result = {
    endpoint: undefined,
    stateFile: STATE_FILE,
    timeoutMs: 2000,
    playwright: false,
    diagnose: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE.trimStart());
      process.exit(0);
    }
    if (arg === '--endpoint') {
      result.endpoint = argv[++i];
      if (!result.endpoint) {
        failArgs('Missing value for --endpoint');
      }
      continue;
    }
    if (arg === '--state-file') {
      result.stateFile = argv[++i];
      if (!result.stateFile) {
        failArgs('Missing value for --state-file');
      }
      continue;
    }
    if (arg === '--timeout-ms') {
      const raw = argv[++i];
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        failArgs('Expected positive integer for --timeout-ms');
      }
      result.timeoutMs = parsed;
      continue;
    }
    if (arg === '--playwright') {
      result.playwright = true;
      continue;
    }
    if (arg === '--diagnose') {
      result.diagnose = true;
      continue;
    }
    failArgs(`Unknown argument: ${arg}`);
  }

  return result;
}

function failArgs(message) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: message,
    hint: 'Run with --help for usage.'
  }) + '\n');
  process.exit(2);
}

function readEndpointState(stateFile) {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(`HTTP ${response.statusCode || 'unknown'}${body ? `: ${body.slice(0, 500)}` : ''}`);
          error.statusCode = response.statusCode;
          error.body = body;
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON: ${error.message}`));
        }
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    request.on('error', reject);
  });
}

async function tryReadHealth(endpoint, timeoutMs) {
  try {
    return await getJson(`${endpoint.replace(/\/$/, '')}/bridgewright/health`, timeoutMs);
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

async function check(endpoint, source, timeoutMs, includePlaywright, includeDiagnostics) {
  const normalized = endpoint.replace(/\/$/, '');
  const health = includeDiagnostics ? await tryReadHealth(normalized, timeoutMs) : undefined;
  const version = await getJson(`${normalized}/json/version`, timeoutMs);
  if (!version.webSocketDebuggerUrl) {
    throw new Error('Missing webSocketDebuggerUrl in /json/version response');
  }
  const versionWithSlash = await getJson(`${normalized}/json/version/`, timeoutMs);
  if (!versionWithSlash.webSocketDebuggerUrl) {
    throw new Error('Missing webSocketDebuggerUrl in /json/version/ response');
  }
  const targets = await getJson(`${normalized}/json/list`, timeoutMs);
  if (!Array.isArray(targets)) {
    throw new Error('Expected /json/list to return an array');
  }
  let playwrightResult;
  if (includePlaywright || includeDiagnostics) {
    playwrightResult = await checkPlaywright(normalized, timeoutMs, includeDiagnostics, includePlaywright);
  }
  return {
    ok: true,
    endpoint: normalized,
    source,
    health,
    browser: version.Browser || null,
    protocolVersion: version['Protocol-Version'] || null,
    webSocketDebuggerUrl: version.webSocketDebuggerUrl,
    trailingSlashWebSocketDebuggerUrl: versionWithSlash.webSocketDebuggerUrl,
    cdpDiscovery: {
      version: true,
      versionSlash: true,
      list: true
    },
    targetCount: targets.length,
    targets: targets.map(summarizeTarget),
    playwright: playwrightResult
  };
}

function summarizeTarget(target) {
  return {
    id: typeof target.id === 'string' ? target.id : null,
    type: typeof target.type === 'string' ? target.type : null,
    title: typeof target.title === 'string' ? target.title : null,
    url: typeof target.url === 'string' ? target.url : null,
    webSocketDebuggerUrl: typeof target.webSocketDebuggerUrl === 'string' ? target.webSocketDebuggerUrl : null
  };
}

async function safePageTitle(page) {
  try {
    return await page.title();
  } catch (error) {
    return `title unavailable: ${error.message}`;
  }
}

async function describeContext(context, contextIndex) {
  const pages = context.pages();
  return {
    index: contextIndex,
    pageCount: pages.length,
    pages: await Promise.all(pages.map(async (page, pageIndex) => ({
      index: pageIndex,
      url: page.url(),
      title: await safePageTitle(page),
      frames: page.frames().map((frame, frameIndex) => ({
        index: frameIndex,
        name: frame.name(),
        url: frame.url()
      }))
    })))
  };
}

async function checkPlaywright(endpoint, timeoutMs, includeDiagnostics, requirePlaywright) {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch (error) {
    if (!requirePlaywright) {
      return {
        skipped: true,
        reason: `playwright package not available: ${error.message}`
      };
    }
    throw new Error(`Playwright import failed: ${error.message}`);
  }
  const browser = await playwright.chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
  try {
    const contexts = browser.contexts();
    const diagnostics = includeDiagnostics
      ? { contexts: await Promise.all(contexts.map((context, index) => describeContext(context, index))) }
      : undefined;
    return {
      connected: browser.isConnected(),
      contextCount: contexts.length,
      diagnostics
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidates = [];
  const endpointState = readEndpointState(args.stateFile);

  if (args.endpoint) {
    candidates.push({ endpoint: args.endpoint, source: 'argument' });
  } else {
    candidates.push({ endpoint: DEFAULT_ENDPOINT, source: 'default-port' });
    const fromFile = typeof endpointState?.endpoint === 'string' && endpointState.endpoint.length > 0 ? endpointState.endpoint : undefined;
    if (fromFile && fromFile !== DEFAULT_ENDPOINT) {
      candidates.push({ endpoint: fromFile, source: 'endpoint-file' });
    }
  }

  const failures = [];
  for (const candidate of candidates) {
    try {
      const result = await check(candidate.endpoint, candidate.source, args.timeoutMs, args.playwright, args.diagnose);
      process.stdout.write(JSON.stringify(result) + '\n');
      return;
    } catch (error) {
      const health = await tryReadHealth(candidate.endpoint, args.timeoutMs);
      const candidateState = endpointState?.endpoint === candidate.endpoint ? endpointState : undefined;
      const staleReadyState = Boolean(
        candidateState
        && candidateState.status === 'running'
        && candidateState.cdpReady === true
        && /ECONNREFUSED/.test(`${error.message} ${health.error || ''}`)
      );
      failures.push({
        endpoint: candidate.endpoint,
        source: candidate.source,
        error: error.message,
        health,
        endpointState: candidateState,
        staleReadyState
      });
    }
  }

  process.stdout.write(JSON.stringify({
    ok: false,
    checked: failures,
    stateFile: args.stateFile,
    hint: 'Start the Bridgewright bridge from the VS Code status bar, then rerun this check.'
  }) + '\n');
  process.exit(1);
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error.message,
    hint: 'Unexpected checker failure.'
  }) + '\n');
  process.exit(1);
});
