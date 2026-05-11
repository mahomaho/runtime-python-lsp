import * as vscode from 'vscode';
import { sessions } from './sessionState';
import { setHelperPath } from './debugBridge';
import { CompletionProvider } from './completionProvider';
import { SignatureHelpProviderImpl } from './signatureHelpProvider';
import { HoverProviderImpl } from './hoverProvider';
import { setLogger } from './logger';

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel('Runtime Python LSP');
    context.subscriptions.push(output);
    setLogger(output);

    setHelperPath(context.extensionPath);

    const trackerFactory: vscode.DebugAdapterTrackerFactory = {
        createDebugAdapterTracker(session) {
            if (session.type !== 'python' && session.type !== 'debugpy') {
                return undefined;
            }
            return new RuntimeLspTracker(session);
        },
    };

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterTrackerFactory('python', trackerFactory),
        vscode.debug.registerDebugAdapterTrackerFactory('debugpy', trackerFactory),
    );

    context.subscriptions.push(
        vscode.debug.onDidTerminateDebugSession((s) => {
            sessions.markTerminated(s.id);
            log(`session terminated: ${s.id} (${s.type})`);
        }),
    );

    const pySelector: vscode.DocumentSelector = {
        language: 'python',
        scheme: 'file',
        pattern: '**/*.py',
    };
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(pySelector, new CompletionProvider(), '.'),
        vscode.languages.registerSignatureHelpProvider(pySelector, new SignatureHelpProviderImpl(), '(', ','),
        vscode.languages.registerHoverProvider(pySelector, new HoverProviderImpl()),
        // Suppress VS Code's built-in debug variable hover so our rich language
        // hover shows without needing Alt. Returning undefined here makes VS Code
        // fall through and skip the debug hover for this selector's matches.
        vscode.languages.registerEvaluatableExpressionProvider(pySelector, {
            provideEvaluatableExpression: () => undefined,
        }),
    );

    log('extension activated, providers registered (python, scheme=file)');
}

export function deactivate(): void {
    sessions.dispose();
}

function log(msg: string): void {
    output?.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

class RuntimeLspTracker implements vscode.DebugAdapterTracker {
    constructor(private readonly session: vscode.DebugSession) {
        log(`tracker attached: session=${session.id} type=${session.type} name=${session.name}`);
    }

    onDidSendMessage(message: unknown): void {
        const m = message as { type?: string; event?: string; body?: { threadId?: number; reason?: string } };
        if (m.type !== 'event') return;

        if (m.event === 'stopped') {
            const threadId = m.body?.threadId;
            sessions.markStopped(this.session, threadId);
            log(`stopped: session=${this.session.id} thread=${threadId} reason=${m.body?.reason}`);
        } else if (m.event === 'continued') {
            sessions.markContinued(this.session.id);
            log(`continued: session=${this.session.id}`);
        } else if (m.event === 'terminated' || m.event === 'exited') {
            sessions.markTerminated(this.session.id);
            log(`${m.event}: session=${this.session.id}`);
        }
    }

    onError(error: Error): void {
        log(`tracker error: session=${this.session.id}: ${error.message}`);
    }

    onExit(code: number | undefined, signal: string | undefined): void {
        sessions.markTerminated(this.session.id);
        log(`tracker exit: session=${this.session.id} code=${code} signal=${signal}`);
    }
}
