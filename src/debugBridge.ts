import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { sessions } from './sessionState';
import { log } from './logger';

export type EvaluateContext = 'watch' | 'hover' | 'repl';

export interface EvaluateResult {
    result: string;
    type?: string;
    variablesReference?: number;
}

let helperSource: string | null = null;
let helperHash: string | null = null;

export function setHelperPath(extensionPath: string): void {
    const candidates = [
        path.join(extensionPath, 'src', 'helper.py'),
        path.join(extensionPath, 'out', 'helper.py'),
    ];
    for (const p of candidates) {
        try {
            helperSource = fs.readFileSync(p, 'utf8');
            helperHash = crypto.createHash('sha1').update(helperSource).digest('hex').slice(0, 12);
            log(`helper.py loaded from ${p} (${helperSource.length} bytes, hash=${helperHash})`);
            return;
        } catch {
            // try next
        }
    }
    helperSource = null;
    helperHash = null;
    log(`helper.py NOT FOUND at ${candidates.join(' or ')}`);
}

function buildInjectionExpression(source: string): string {
    const b64 = Buffer.from(source, 'utf8').toString('base64');
    // Re-exec'ing source into the existing module's __dict__ updates the
    // function definitions, so re-injection picks up new helper code.
    return (
        `(lambda __s: __import__('builtins').exec(` +
        `compile(__s, '<_lsp_helper>', 'exec'), ` +
        `__import__('sys').modules.setdefault('_lsp_helper', ` +
        `__import__('types').ModuleType('_lsp_helper')).__dict__))` +
        `(__import__('base64').b64decode('${b64}').decode('utf-8'))`
    );
}

function timeoutMs(): number {
    const cfg = vscode.workspace.getConfiguration('runtimePythonLsp');
    return cfg.get<number>('evaluateTimeoutMs', 5000);
}

export async function evaluate(
    session: vscode.DebugSession,
    frameId: number | undefined,
    expression: string,
    context: EvaluateContext,
    token?: vscode.CancellationToken,
): Promise<EvaluateResult | undefined> {
    const args: Record<string, unknown> = { expression, context };
    if (frameId !== undefined) {
        args.frameId = frameId;
    }

    const req = session.customRequest('evaluate', args);
    const timer = new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), timeoutMs()),
    );
    const cancel = new Promise<undefined>((resolve) => {
        if (token) {
            token.onCancellationRequested(() => resolve(undefined));
        }
    });

    try {
        const result = await Promise.race([req, timer, cancel]);
        return result as EvaluateResult | undefined;
    } catch {
        return undefined;
    }
}

export async function ensureHelperInjected(
    session: vscode.DebugSession,
    frameId: number | undefined,
    token?: vscode.CancellationToken,
): Promise<boolean> {
    const state = sessions.get(session.id);
    if (!state) {
        log('ensureHelperInjected: session not in paused registry');
        return false;
    }
    if (!helperSource || !helperHash) {
        log('ensureHelperInjected: no helper source loaded');
        return false;
    }
    if (state.injectedHelperHash === helperHash) return true;

    const expr = buildInjectionExpression(helperSource);
    const result = await evaluate(session, frameId, expr, 'repl', token);
    if (result === undefined) {
        log(`ensureHelperInjected: injection eval returned undefined (timeout or error) frameId=${frameId}`);
        return false;
    }
    sessions.setHelperInjected(session.id, helperHash);
    log(`ensureHelperInjected: helper injected (hash=${helperHash}) into session=${session.id}`);
    return true;
}

function pyStringLiteral(s: string): string {
    const b64 = Buffer.from(s, 'utf8').toString('base64');
    return `__import__('base64').b64decode('${b64}').decode('utf-8')`;
}

export async function callIntrospect(
    session: vscode.DebugSession,
    frameId: number | undefined,
    expression: string,
    context: EvaluateContext,
    token?: vscode.CancellationToken,
): Promise<unknown[] | undefined> {
    if (!(await ensureHelperInjected(session, frameId, token))) return undefined;
    const call = wrapBase64(
        `__import__('sys').modules['_lsp_helper'].introspect(` +
        `eval(compile(${pyStringLiteral(expression)}, '<lsp-expr>', 'eval')))`,
    );
    const result = await evaluate(session, frameId, call, context, token);
    if (!result) {
        log(`callIntrospect("${expression}"): evaluate returned undefined`);
        return undefined;
    }
    const parsed = decodeBase64Json(result.result);
    if (!Array.isArray(parsed)) {
        log(`callIntrospect("${expression}"): could not decode result: ${result.result.slice(0, 120)}`);
        return undefined;
    }
    return parsed as unknown[];
}

export async function callDescribe(
    session: vscode.DebugSession,
    frameId: number | undefined,
    expression: string,
    context: EvaluateContext,
    token?: vscode.CancellationToken,
): Promise<Record<string, unknown> | undefined> {
    if (!(await ensureHelperInjected(session, frameId, token))) return undefined;
    const call = wrapBase64(
        `__import__('sys').modules['_lsp_helper'].describe(` +
        `eval(compile(${pyStringLiteral(expression)}, '<lsp-expr>', 'eval')))`,
    );
    const result = await evaluate(session, frameId, call, context, token);
    if (!result) return undefined;
    const parsed = decodeBase64Json(result.result);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        ? (parsed as Record<string, unknown>)
        : undefined;
}

/**
 * Wrap a Python expression that returns a JSON string so it instead returns
 * base64(utf-8(json)). This avoids Python repr quoting issues in the
 * debugpy `evaluate` response.
 */
function wrapBase64(jsonExpr: string): string {
    return `__import__('base64').b64encode((${jsonExpr}).encode('utf-8')).decode('ascii')`;
}

/**
 * Decode a `result.result` string of the form `'BASE64'` (Python repr of an
 * ASCII string) into the parsed JSON value.
 */
function decodeBase64Json(raw: string): unknown {
    const s = stripPyStringQuotes(raw);
    if (s === undefined) return undefined;
    let json: string;
    try {
        json = Buffer.from(s, 'base64').toString('utf8');
    } catch {
        return undefined;
    }
    try {
        return JSON.parse(json);
    } catch {
        return undefined;
    }
}

function stripPyStringQuotes(raw: string): string | undefined {
    if (raw.length < 2) return undefined;
    // Optional prefixes like b'...' / u'...' shouldn't appear here, but tolerate them.
    let s = raw;
    if (/^[bBuU]/.test(s) && (s[1] === "'" || s[1] === '"')) s = s.slice(1);
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === "'" || first === '"') && first === last) {
        return s.slice(1, -1);
    }
    // Some adapters return without quotes; accept as-is.
    return s;
}
