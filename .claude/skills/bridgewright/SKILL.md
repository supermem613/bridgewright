---
name: bridgewright
description: Use when browser automation runs inside a Codespace and should connect to the local browser bridge through the repo's Bridgewright VS Code extension.
userInvocable: true
---

# Bridgewright

## Core Principles

1. **Use the localhost CDP contract first.** Code inside Codespaces should use `chromium.connectOverCDP('http://127.0.0.1:37373')` without VS Code APIs, custom fixtures, or extension internals.
2. **Treat the extension as the bridge owner.** If the endpoint is missing, stale, or unhealthy, ask the user to start the **Bridgewright** status bar bridge in VS Code. Do not try to start Windows Edge from inside the Codespace.
3. **Read machine-readable state when the default port fails.** The extension writes `~/.bridgewright/endpoint.json` inside the Codespace when running.
4. **Never proxy through agent code.** Agents should connect Playwright to the advertised endpoint. They should not build their own tunnel, browser launcher, or fixture unless explicitly debugging the extension.
5. **Use named profiles only when isolation is required.** `default` is durable. `/profiles/<name>` is ephemeral Bridgewright-owned browser state that is deleted on Bridgewright start, stop, close, or remove.

## Codespace Contract Reference

Default endpoint:

```text
http://127.0.0.1:37373
```

Named profile endpoint:

```text
http://127.0.0.1:37373/profiles/kash-work
```

Valid profile names match:

```text
[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}
```

Endpoint state file:

```text
~/.bridgewright/endpoint.json
```

Expected `endpoint.json` shape:

```json
{
  "endpoint": "http://127.0.0.1:37373",
  "port": 37373,
  "protocol": "cdp",
  "status": "running",
  "owner": "bridgewright",
  "updatedAt": "2026-05-21T18:36:00.000Z"
}
```

CDP health check:

```text
GET /json/version
```

Named profile health check:

```text
GET /profiles/kash-work/json/version
```

Minimum healthy response fields:

```json
{
  "Browser": "Edg/149.0.4022.16",
  "Protocol-Version": "1.3",
  "webSocketDebuggerUrl": "ws://127.0.0.1:37373/devtools/browser/..."
}
```

## Scripts

Use the bundled checker before running browser automation:

```bash
node .claude/skills/bridgewright/scripts/check-endpoint.js
```

For downstream app-readiness bugs, include a non-mutating browser snapshot:

```bash
node .claude/skills/bridgewright/scripts/check-endpoint.js --diagnose --timeout-ms 20000
```

If the current repo does not contain the Bridgewright skill files, fetch the checker from the running endpoint:

```bash
curl -fsSL http://127.0.0.1:37373/bridgewright/check-endpoint.js | node - --diagnose --timeout-ms 20000
```

`--diagnose` must remain repo-independent. If Playwright is unavailable, it should return `ok: true` when HTTP/CDP health is green and include `playwright.skipped: true`. Use `--playwright` only when attach verification is required and the repo can resolve the Playwright package.

Machine-readable output is JSON on stdout. A successful result includes:

```json
{
  "ok": true,
  "endpoint": "http://127.0.0.1:37373",
  "source": "default-port",
  "browser": "Edg/149.0.4022.16"
}
```

## Execution Sequence

1. **Check endpoint health.**
   Run:
   ```bash
   node .claude/skills/bridgewright/scripts/check-endpoint.js
   ```

2. **If healthy, use the returned endpoint.**
   Use this Playwright pattern:
   ```ts
   import { chromium } from 'playwright';

   const browser = await chromium.connectOverCDP('http://127.0.0.1:37373');
   ```

   For kash-style isolation, use a named endpoint:
   ```ts
   const browser = await chromium.connectOverCDP('http://127.0.0.1:37373/profiles/kash-work');
   ```

3. **If unhealthy, do not improvise a tunnel.**
   Tell the user:
   ```text
   Start the Bridgewright bridge from the VS Code status bar, then rerun the endpoint check.
   ```

4. **If the default port is occupied or unavailable, use the state file.**
   The checker automatically falls back to `~/.bridgewright/endpoint.json`.
   If that file points to a healthy endpoint, use it instead of the default port.

5. **Run the automation.**
   Keep the endpoint fixed for the lifetime of the script. If the CDP connection drops, re-run the checker before retrying.

## Profile Lifecycle

- `default` maps to the durable Windows Edge user data directory and must not be removed by agents.
- Non-default profiles map to Windows `~\.bridgewright\profiles\<name>\edge-user-data`.
- Bridgewright removes all non-default profiles on start and stop.
- Use `POST /profiles/<name>/close` or `POST /profiles/<name>/remove` when an isolated run is done.
- `close` and `remove` reject `default`.

## Patterns and Pitfalls

**Symptom:** `connectOverCDP` fails with `ECONNREFUSED` against `127.0.0.1:37373`.  
**Root cause:** The extension bridge is not running, the status bar bridge was stopped, or the Codespace helper endpoint failed to start.  
**Fix:** Ask the user to start the Bridgewright status bar bridge and rerun `check-endpoint.js`.

**Symptom:** `/json/version` works but WebSocket connect fails.  
**Root cause:** The endpoint facade is not rewriting or proxying the CDP WebSocket correctly.  
**Fix:** Report this as an extension bug with the `/json/version` JSON and the Playwright error. Do not switch to a custom fixture.

**Symptom:** The agent wants to import a helper package or custom Playwright fixture.  
**Root cause:** Confusing this project with RushStack's `playwright-local-browser-server` model.  
**Fix:** Do not use fixtures. The non-negotiable contract is plain `chromium.connectOverCDP(endpoint)`.

**Symptom:** A named profile is expected to preserve login state across Bridgewright restarts.  
**Root cause:** Non-default profiles are intentionally ephemeral to prevent disposable Codespaces from leaking host-side browser data forever.  
**Fix:** Use `default` only when durable state is required.

## Anti-Patterns

- **Do not call VS Code APIs from Codespace automation.** Third-party code and agents should only need the localhost CDP URL.
- **Do not use RushStack's `tunneledBrowser()` fixture model.** It violates the requirement that unmodified Codespace code can connect to a plain CDP endpoint.
- **Do not hardcode spike ports `9222` or `9223`.** Product default is `37373`; use `endpoint.json` if a fallback port is chosen.
- **Do not start Windows Edge from inside Codespaces.** The Codespace cannot access Windows processes or Windows loopback directly.
- **Do not keep named profiles long term.** Close or remove non-default profiles after use. Bridgewright will also clean them on start and stop.

## Output Format

When reporting readiness, use:

```text
Bridgewright endpoint: <endpoint>
Browser: <browser>
Status: ready | not-ready
Next: <exact action>
```
