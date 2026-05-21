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
  node .claude/skills/bridgewright/scripts/check-endpoint.js [--endpoint <url>] [--timeout-ms <ms>] [--playwright]

Checks /json/version and /json/list for the Bridgewright CDP endpoint.
Use --playwright to also verify chromium.connectOverCDP.

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
    timeoutMs: 2000,
    playwright: false
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

function readEndpointFile() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.endpoint === 'string' && parsed.endpoint.length > 0) {
      return parsed.endpoint;
    }
  } catch {
    return undefined;
  }
  return undefined;
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
          reject(new Error(`HTTP ${response.statusCode || 'unknown'}`));
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

async function check(endpoint, source, timeoutMs, includePlaywright) {
  const normalized = endpoint.replace(/\/$/, '');
  const version = await getJson(`${normalized}/json/version`, timeoutMs);
  if (!version.webSocketDebuggerUrl) {
    throw new Error('Missing webSocketDebuggerUrl in /json/version response');
  }
  const targets = await getJson(`${normalized}/json/list`, timeoutMs);
  if (!Array.isArray(targets)) {
    throw new Error('Expected /json/list to return an array');
  }
  let playwrightResult;
  if (includePlaywright) {
    playwrightResult = await checkPlaywright(normalized, timeoutMs);
  }
  return {
    ok: true,
    endpoint: normalized,
    source,
    browser: version.Browser || null,
    protocolVersion: version['Protocol-Version'] || null,
    webSocketDebuggerUrl: version.webSocketDebuggerUrl,
    targetCount: targets.length,
    playwright: playwrightResult
  };
}

async function checkPlaywright(endpoint, timeoutMs) {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch (error) {
    throw new Error(`Playwright import failed: ${error.message}`);
  }
  const browser = await playwright.chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
  try {
    return {
      connected: browser.isConnected(),
      contextCount: browser.contexts().length
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidates = [];

  if (args.endpoint) {
    candidates.push({ endpoint: args.endpoint, source: 'argument' });
  } else {
    candidates.push({ endpoint: DEFAULT_ENDPOINT, source: 'default-port' });
    const fromFile = readEndpointFile();
    if (fromFile && fromFile !== DEFAULT_ENDPOINT) {
      candidates.push({ endpoint: fromFile, source: 'endpoint-file' });
    }
  }

  const failures = [];
  for (const candidate of candidates) {
    try {
      const result = await check(candidate.endpoint, candidate.source, args.timeoutMs, args.playwright);
      process.stdout.write(JSON.stringify(result) + '\n');
      return;
    } catch (error) {
      failures.push({
        endpoint: candidate.endpoint,
        source: candidate.source,
        error: error.message
      });
    }
  }

  process.stdout.write(JSON.stringify({
    ok: false,
    checked: failures,
    stateFile: STATE_FILE,
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
