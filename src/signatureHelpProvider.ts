import * as vscode from 'vscode';
import { sessions } from './sessionState';
import { resolveCallContext, resolveExpressionBeforeCursor } from './exprResolver';
import { pickFrame } from './frameSelector';
import { callIntrospect, callDescribe } from './debugBridge';
import { IntrospectItem, IntrospectParam } from './introspectTypes';
import { getCachedIntrospect, setCachedIntrospect } from './cache';

export class SignatureHelpProviderImpl implements vscode.SignatureHelpProvider {
    async provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): Promise<vscode.SignatureHelp | undefined> {
        const paused = sessions.pickPython();
        if (!paused) return undefined;

        const line = document.lineAt(position.line).text;
        const callCtx = resolveCallContext(line, position.character);
        if (!callCtx) return undefined;

        const frame = await pickFrame(paused.session, paused.threadId, document, position.line, token);
        if (!frame) return undefined;
        if (token.isCancellationRequested) return undefined;

        const params = await resolveCalleeSignature(
            paused.session,
            paused.session.id,
            frame.frameId,
            callCtx.callee,
            token,
        );
        if (!params) return undefined;

        const help = new vscode.SignatureHelp();
        const sig = new vscode.SignatureInformation(
            `${callCtx.callee}${params.signature}`,
        );
        sig.parameters = params.params.map((p) => new vscode.ParameterInformation(p.name));
        help.signatures = [sig];
        help.activeSignature = 0;
        help.activeParameter = clamp(callCtx.activeParameter, 0, Math.max(0, params.params.length - 1));
        return help;
    }
}

interface ResolvedSignature {
    signature: string;
    params: IntrospectParam[];
}

async function resolveCalleeSignature(
    session: vscode.DebugSession,
    sessionId: string,
    frameId: number,
    callee: string,
    token: vscode.CancellationToken,
): Promise<ResolvedSignature | undefined> {
    // If the callee is "parent.member", we may already have introspected the parent.
    const parsed = resolveExpressionBeforeCursor(callee + '.', callee.length + 1);
    if (parsed && !parsed.isBareName) {
        const cached = getCachedIntrospect(sessionId, frameId, parsed.base);
        const hit = cached?.find((i) => i.name === parsed.prefix);
        if (hit?.signature && hit.params) {
            return { signature: hit.signature, params: hit.params };
        }
        const fetched = await callIntrospect(session, frameId, parsed.base, 'watch', token);
        if (fetched) {
            const items = fetched as IntrospectItem[];
            setCachedIntrospect(sessionId, frameId, parsed.base, items);
            const hit2 = items.find((i) => i.name === parsed.prefix);
            if (hit2?.signature && hit2.params) {
                return { signature: hit2.signature, params: hit2.params };
            }
        }
    }

    // Fall back to describe(callee).
    const desc = await callDescribe(session, frameId, callee, 'watch', token);
    if (!desc || !desc.signature) return undefined;
    return { signature: desc.signature as string, params: [] };
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}
