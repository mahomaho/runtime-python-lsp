import * as vscode from 'vscode';

export interface PausedFrameKey {
    sessionId: string;
    threadId: number;
    stoppedSeq: number;
}

export interface PausedSession {
    session: vscode.DebugSession;
    threadId: number | undefined;
    stoppedSeq: number;
    /** Hash of the helper source most recently injected into this session. */
    injectedHelperHash: string | undefined;
}

class SessionRegistry {
    private readonly paused = new Map<string, PausedSession>();
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onChanged = this.emitter.event;

    markStopped(session: vscode.DebugSession, threadId: number | undefined): void {
        const prev = this.paused.get(session.id);
        const stoppedSeq = (prev?.stoppedSeq ?? 0) + 1;
        this.paused.set(session.id, {
            session,
            threadId,
            stoppedSeq,
            injectedHelperHash: prev?.injectedHelperHash,
        });
        this.emitter.fire();
    }

    markContinued(sessionId: string): void {
        if (this.paused.delete(sessionId)) {
            this.emitter.fire();
        }
    }

    markTerminated(sessionId: string): void {
        if (this.paused.delete(sessionId)) {
            this.emitter.fire();
        }
    }

    get(sessionId: string): PausedSession | undefined {
        return this.paused.get(sessionId);
    }

    setHelperInjected(sessionId: string, hash: string): void {
        const s = this.paused.get(sessionId);
        if (s) {
            s.injectedHelperHash = hash;
        }
    }

    anyPaused(): boolean {
        return this.paused.size > 0;
    }

    pickPython(): PausedSession | undefined {
        for (const s of this.paused.values()) {
            if (s.session.type === 'python' || s.session.type === 'debugpy') {
                return s;
            }
        }
        return undefined;
    }

    dispose(): void {
        this.paused.clear();
        this.emitter.dispose();
    }
}

export const sessions = new SessionRegistry();
