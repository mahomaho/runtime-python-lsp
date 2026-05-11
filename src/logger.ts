import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function setLogger(c: vscode.OutputChannel): void {
    channel = c;
}

export function log(msg: string): void {
    channel?.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

export function trace(msg: string): void {
    if (!channel) return;
    const cfg = vscode.workspace.getConfiguration('runtimePythonLsp');
    if (cfg.get<boolean>('trace.dap', false)) {
        channel.appendLine(`[${new Date().toLocaleTimeString()}] [trace] ${msg}`);
    }
}
