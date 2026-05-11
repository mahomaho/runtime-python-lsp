import * as vscode from 'vscode';
import { sessions } from './sessionState';
import { resolveExpressionBeforeCursor } from './exprResolver';
import { pickFrame } from './frameSelector';
import { callIntrospect, callDescribe } from './debugBridge';
import { DescribeResult, IntrospectItem, IntrospectKind, IntrospectParam } from './introspectTypes';
import {
    getCachedDescribe,
    getCachedIntrospect,
    setCachedDescribe,
    setCachedIntrospect,
} from './cache';
import { BareNameItem, collectBareNames } from './bareNameCompletion';
import { log, trace } from './logger';
import { buildDescribeMarkdown } from './describeMarkdown';

const RUNTIME_TAG = '(runtime)';

interface ResolveContext {
    sessionId: string;
    frameId: number;
    fullExpression: string;
}

interface RuntimeCompletionItem extends vscode.CompletionItem {
    _runtimeCtx?: ResolveContext;
}

export class CompletionProvider implements vscode.CompletionItemProvider {
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _context: vscode.CompletionContext,
    ): Promise<vscode.CompletionItem[] | undefined> {
        const paused = sessions.pickPython();
        if (!paused) {
            trace('completion: no paused python session — silent');
            return undefined;
        }

        const line = document.lineAt(position.line).text;
        const resolved = resolveExpressionBeforeCursor(line, position.character);
        if (!resolved) {
            trace(`completion: could not resolve expression at line ${position.line}, col ${position.character}`);
            return undefined;
        }

        const frame = await pickFrame(paused.session, paused.threadId, document, position.line, token);
        if (!frame) {
            log('completion: pickFrame returned undefined (no stopped thread or no stack)');
            return undefined;
        }
        if (token.isCancellationRequested) return undefined;

        const sessionId = paused.session.id;

        if (resolved.isBareName) {
            if (paused.threadId === undefined) return undefined;
            const names = await collectBareNames(
                paused.session,
                paused.threadId,
                frame.frameId,
                token,
            );
            log(`completion: bare-name returned ${names.length} items (prefix=${resolved.prefix || '""'})`);
            if (names.length === 0) return undefined;
            const items = names.map((info) => toBareNameItem(info, sessionId, frame.frameId));
            return finalize(items);
        }

        let items = getCachedIntrospect(sessionId, frame.frameId, resolved.base);
        if (!items) {
            const fetched = await callIntrospect(paused.session, frame.frameId, resolved.base, 'watch', token);
            if (!fetched) {
                log(`completion: introspect("${resolved.base}") returned undefined (eval failed/timed out)`);
                return undefined;
            }
            items = fetched as IntrospectItem[];
            setCachedIntrospect(sessionId, frame.frameId, resolved.base, items);
        }

        log(`completion: ${resolved.base}.${resolved.prefix || '*'} → ${items.length} items`);
        if (items.length === 0) return undefined;
        const completionItems = items.map((info) =>
            toCompletionItem(info, sessionId, frame.frameId, resolved.base),
        );
        return finalize(completionItems);
    }

    async resolveCompletionItem(
        item: vscode.CompletionItem,
        token: vscode.CancellationToken,
    ): Promise<vscode.CompletionItem> {
        const ctx = (item as RuntimeCompletionItem)._runtimeCtx;
        if (!ctx) {
            log(`resolveCompletionItem: no ctx on item "${labelText(item)}"`);
            return item;
        }

        const paused = sessions.pickPython();
        if (!paused) {
            log(`resolveCompletionItem("${ctx.fullExpression}"): no paused python session`);
            return item;
        }
        if (paused.session.id !== ctx.sessionId) {
            log(`resolveCompletionItem("${ctx.fullExpression}"): session changed`);
            return item;
        }

        let desc = getCachedDescribe(ctx.sessionId, ctx.frameId, ctx.fullExpression);
        if (!desc) {
            const fetched = await callDescribe(
                paused.session,
                ctx.frameId,
                ctx.fullExpression,
                'watch',
                token,
            );
            if (!fetched || typeof fetched.type !== 'string') {
                log(`resolveCompletionItem("${ctx.fullExpression}"): describe returned no result`);
                return item;
            }
            desc = fetched as unknown as DescribeResult;
            setCachedDescribe(ctx.sessionId, ctx.frameId, ctx.fullExpression, desc);
        }

        item.documentation = buildDescribeMarkdown(ctx.fullExpression, desc);
        log(`resolveCompletionItem("${ctx.fullExpression}"): documentation set`);
        return item;
    }
}

function finalize(items: vscode.CompletionItem[]): vscode.CompletionItem[] {
    if (items.length > 0) {
        items[0].preselect = true;
    }
    return items;
}

function labelText(item: vscode.CompletionItem): string {
    return typeof item.label === 'string' ? item.label : item.label.label;
}

function toBareNameItem(
    info: BareNameItem,
    sessionId: string,
    frameId: number,
): vscode.CompletionItem {
    const item: RuntimeCompletionItem = new vscode.CompletionItem(
        info.name,
        vscode.CompletionItemKind.Variable,
    );
    const t = info.type ?? 'object';
    item.detail = `${info.scopeKind}: ${t} ${RUNTIME_TAG}`;
    item.sortText = ` ${info.name}`;
    if (info.value) {
        const md = new vscode.MarkdownString();
        md.appendCodeblock(`${info.name} = ${info.value}`, 'python');
        md.appendMarkdown(`\n\n*${info.frameOrigin}*`);
        md.isTrusted = false;
        item.documentation = md;
    }
    item._runtimeCtx = { sessionId, frameId, fullExpression: info.name };
    return item;
}

function toCompletionItem(
    info: IntrospectItem,
    sessionId: string,
    frameId: number,
    parentExpr: string,
): vscode.CompletionItem {
    const item: RuntimeCompletionItem = new vscode.CompletionItem(
        info.name,
        kindToVscode(info.kind),
    );
    item.detail = buildDetail(info);
    item.sortText = ` ${info.name}`;

    if (info.doc) {
        const md = new vscode.MarkdownString(firstParagraph(info.doc));
        md.isTrusted = false;
        item.documentation = md;
    }

    if (isCallable(info.kind) && info.params) {
        item.insertText = buildSnippet(info.name, info.params);
    }

    item._runtimeCtx = {
        sessionId,
        frameId,
        fullExpression: `${parentExpr}.${info.name}`,
    };
    return item;
}

function kindToVscode(kind: IntrospectKind): vscode.CompletionItemKind {
    switch (kind) {
        case 'class': return vscode.CompletionItemKind.Class;
        case 'method': return vscode.CompletionItemKind.Method;
        case 'function': return vscode.CompletionItemKind.Function;
        case 'builtin': return vscode.CompletionItemKind.Function;
        case 'callable': return vscode.CompletionItemKind.Function;
        case 'attribute': return vscode.CompletionItemKind.Field;
    }
}

function isCallable(kind: IntrospectKind): boolean {
    return kind !== 'attribute';
}

function buildDetail(info: IntrospectItem): string {
    if (isCallable(info.kind) && info.signature) {
        return `${info.name}${info.signature} ${RUNTIME_TAG}`;
    }
    const t = info.type ?? 'object';
    return `${info.kind}: ${t} ${RUNTIME_TAG}`;
}

function firstParagraph(doc: string): string {
    const idx = doc.indexOf('\n\n');
    return idx < 0 ? doc : doc.slice(0, idx);
}

function buildSnippet(name: string, params: IntrospectParam[]): vscode.SnippetString {
    const required: string[] = [];
    let placeholderIdx = 1;
    for (let i = 0; i < params.length; i++) {
        const p = params[i];
        if (i === 0 && (p.name === 'self' || p.name === 'cls')) continue;
        if (p.kind === 'VAR_POSITIONAL' || p.kind === 'VAR_KEYWORD') continue;
        if (p.has_default) continue;
        required.push(`\${${placeholderIdx++}:${p.name}}`);
    }
    const snippet = new vscode.SnippetString();
    snippet.value = `${name}(${required.join(', ')})$0`;
    return snippet;
}
