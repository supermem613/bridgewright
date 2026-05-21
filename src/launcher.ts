export interface RemoteLauncherOptions {
  readonly helperPath: string;
  readonly readyPath: string;
  readonly logPath: string;
  readonly cdpPort: number;
  readonly tunnelPort: number;
}

export function remoteShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createRemoteLauncherScript(options: RemoteLauncherOptions): string {
  const helperPath = remoteShellQuote(options.helperPath);
  const readyPath = remoteShellQuote(options.readyPath);
  const logPath = remoteShellQuote(options.logPath);
  return [
    '#!/usr/bin/env sh',
    'set -eu',
    `log=${logPath}`,
    'log_dir=$(dirname "$log")',
    'mkdir -p "$log_dir"',
    ': >> "$log"',
    '{',
    '  printf "%s launching bridgewright helper\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    '  printf "%s node path: " "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    '  command -v node || true',
    '  printf "%s working directory: %s\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(pwd)"',
    '  exec node \\',
    `    ${helperPath} \\`,
    '    --replace-existing \\',
    '    --cdp-port \\',
    `    ${options.cdpPort} \\`,
    '    --tunnel-port \\',
    `    ${options.tunnelPort} \\`,
    '    --ready-file \\',
    `    ${readyPath} \\`,
    '    --runtime-log \\',
    `    ${logPath}`,
    '} >> "$log" 2>&1',
    '',
  ].join('\n');
}
