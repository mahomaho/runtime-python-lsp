import * as vscode from 'vscode';
import { getAllFrames } from './frameSelector';

interface DapScope {
    name: string;
    variablesReference: number;
    expensive?: boolean;
    presentationHint?: string;
}

interface DapVariable {
    name: string;
    value: string;
    type?: string;
    variablesReference?: number;
}

export interface BareNameItem {
    name: string;
    type?: string;
    value?: string;
    frameOrigin: string;
    scopeKind: string;
}

const SKIP_NAMES = new Set([
    'special variables',
    'function variables',
    'class variables',
    'protected variables',
]);

export async function collectBareNames(
    session: vscode.DebugSession,
    threadId: number,
    preferredFrameId: number,
    token: vscode.CancellationToken,
): Promise<BareNameItem[]> {
    const frames = await getAllFrames(session, threadId, token);
    if (frames.length === 0) return [];

    // Order: preferred frame first, then the rest in stack order.
    const ordered = [...frames].sort((a, b) =>
        a.id === preferredFrameId ? -1 : b.id === preferredFrameId ? 1 : 0,
    );

    const seen = new Map<string, BareNameItem>();
    for (const frame of ordered) {
        if (token.isCancellationRequested) break;
        const scopes = await fetchScopes(session, frame.id);
        for (const scope of scopes) {
            if (token.isCancellationRequested) break;
            if (scope.expensive) continue;
            const vars = await fetchVariables(session, scope.variablesReference);
            for (const v of vars) {
                if (SKIP_NAMES.has(v.name)) continue;
                if (!isIdentifier(v.name)) continue;
                if (seen.has(v.name)) continue;
                seen.set(v.name, {
                    name: v.name,
                    type: v.type,
                    value: v.value,
                    frameOrigin: frameOriginLabel(frame),
                    scopeKind: scope.name,
                });
            }
        }
    }
    return [...seen.values()];
}

async function fetchScopes(session: vscode.DebugSession, frameId: number): Promise<DapScope[]> {
    try {
        const resp = await session.customRequest('scopes', { frameId });
        return (resp?.scopes ?? []) as DapScope[];
    } catch {
        return [];
    }
}

async function fetchVariables(
    session: vscode.DebugSession,
    variablesReference: number,
): Promise<DapVariable[]> {
    try {
        const resp = await session.customRequest('variables', { variablesReference });
        return (resp?.variables ?? []) as DapVariable[];
    } catch {
        return [];
    }
}

function isIdentifier(name: string): boolean {
    return /^[A-Za-z_][\w]*$/.test(name);
}

function frameOriginLabel(frame: { line: number; source?: { path?: string } }): string {
    const fp = frame.source?.path;
    if (!fp) return `line ${frame.line}`;
    const slash = Math.max(fp.lastIndexOf('/'), fp.lastIndexOf('\\'));
    const base = slash >= 0 ? fp.slice(slash + 1) : fp;
    return `${base}:${frame.line}`;
}
