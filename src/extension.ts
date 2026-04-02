import * as vscode from 'vscode';
import { registerParticipant } from './participant';

export function activate(context: vscode.ExtensionContext): void {
  registerParticipant(context);
}

export function deactivate(): void {}
