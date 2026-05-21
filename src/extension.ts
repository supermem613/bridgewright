import * as vscode from 'vscode';
import { BridgeManager } from './manager';

let manager: BridgeManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  manager = new BridgeManager(context);
  context.subscriptions.push(manager);

  context.subscriptions.push(
    vscode.commands.registerCommand('bridgewright.start', async () => {
      await manager?.start();
    }),
    vscode.commands.registerCommand('bridgewright.stop', async () => {
      await manager?.stop();
    }),
    vscode.commands.registerCommand('bridgewright.status', async () => {
      await manager?.showStatus();
    }),
    vscode.commands.registerCommand('bridgewright.endpoint', async () => {
      await manager?.copyEndpoint();
    }),
    vscode.commands.registerCommand('bridgewright.showLogs', async () => {
      await manager?.showLogs();
    }),
  );
}

export function deactivate(): Thenable<void> | undefined {
  return manager?.stop();
}
