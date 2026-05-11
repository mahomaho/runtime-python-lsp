import * as vscode from 'vscode';

export interface PickedFrame {
    frameId: number;
    threadId: number;
    sourcePath?: string;
    line?: number;
}

interface DapStackFrame {
    id: number;
    line: number;
    source?: { path?: string };
}

export async function pickFrame(
    session: vscode.DebugSession,
    threadId: number | undefined,
    document: vscode.TextDocument,
    cursorLine: number,
    token?: vscode.CancellationToken,
): Promise<PickedFrame | undefined> {
    const tid = threadId ?? (await pickStoppedThread(session, token));
    if (tid === undefined) return undefined;

    let frames: DapStackFrame[];
    try {
        const resp = await session.customRequest('stackTrace', {
            threadId: tid,
            startFrame: 0,
            levels: 50,
        });
        frames = (resp?.stackFrames ?? []) as DapStackFrame[];
    } catch {
        return undefined;
    }
    if (frames.length === 0) return undefined;

    const docPath = document.uri.fsPath;
    let best: DapStackFrame | undefined;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const f of frames) {
        const fp = f.source?.path;
        if (!fp) continue;
        if (!samePath(fp, docPath)) continue;
        const dist = Math.abs(f.line - (cursorLine + 1));
        if (dist < bestDist) {
            best = f;
            bestDist = dist;
        }
    }

    const picked = best ?? frames[0];
    return {
        frameId: picked.id,
        threadId: tid,
        sourcePath: picked.source?.path,
        line: picked.line,
    };
}

export async function getAllFrames(
    session: vscode.DebugSession,
    threadId: number,
    token?: vscode.CancellationToken,
): Promise<DapStackFrame[]> {
    void token;
    try {
        const resp = await session.customRequest('stackTrace', {
            threadId,
            startFrame: 0,
            levels: 50,
        });
        return (resp?.stackFrames ?? []) as DapStackFrame[];
    } catch {
        return [];
    }
}

async function pickStoppedThread(
    session: vscode.DebugSession,
    token?: vscode.CancellationToken,
): Promise<number | undefined> {
    void token;
    try {
        const resp = await session.customRequest('threads', {});
        const threads = (resp?.threads ?? []) as { id: number }[];
        return threads[0]?.id;
    } catch {
        return undefined;
    }
}

function samePath(a: string, b: string): boolean {
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    return norm(a) === norm(b);
}
