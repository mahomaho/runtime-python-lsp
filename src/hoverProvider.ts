import * as vscode from 'vscode';
import { sessions } from './sessionState';
import { resolveHoverExpression, walkBackExpression } from './exprResolver';
import { pickFrame } from './frameSelector';
import { callDescribe } from './debugBridge';
import { DescribeResult } from './introspectTypes';
import {
    describeFromIntrospect,
    getCachedDescribe,
    setCachedDescribe,
} from './cache';
import { buildDescribeMarkdown } from './describeMarkdown';
import { log } from './logger';

const IDENT_HOVER_RE = /[A-Za-z_][A-Za-z_0-9]*/;


export class HoverProviderImpl implements vscode.HoverProvider {
    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): Promise<vscode.Hover | undefined> {
        const paused = sessions.pickPython();
        if (!paused) return undefined;

        const wordRange = document.getWordRangeAtPosition(position, IDENT_HOVER_RE);
        if (!wordRange) return undefined;

        const line = document.lineAt(position.line).text;
        const start = walkBackExpression(line, wordRange.end.character);
        const range = new vscode.Range(
            new vscode.Position(position.line, start),
            wordRange.end,
        );
        const expr = resolveHoverExpression(line, {
            start: range.start.character,
            end: range.end.character,
        });
        if (!expr) {
            log(`hover: refused expression at ${position.line}:${position.character}`);
            return undefined;
        }

        const frame = await pickFrame(paused.session, paused.threadId, document, position.line, token);
        if (!frame) {
            log('hover: pickFrame returned undefined');
            return undefined;
        }
        if (token.isCancellationRequested) return undefined;

        const sessionId = paused.session.id;

        let desc = getCachedDescribe(sessionId, frame.frameId, expr);
        if (!desc) {
            const dot = expr.lastIndexOf('.');
            if (dot > 0) {
                const parent = expr.slice(0, dot);
                const member = expr.slice(dot + 1);
                desc = describeFromIntrospect(sessionId, frame.frameId, parent, member);
            }
        }

        if (!desc) {
            const fetched = await callDescribe(paused.session, frame.frameId, expr, 'hover', token);
            if (!fetched || typeof fetched.type !== 'string') {
                log(`hover: describe("${expr}") returned no usable result`);
                return undefined;
            }
            desc = fetched as unknown as DescribeResult;
            setCachedDescribe(sessionId, frame.frameId, expr, desc);
        }

        log(`hover: ${expr} → ${desc.type}${desc.callable_kind ? ' (' + desc.callable_kind + ')' : ''}`);
        return new vscode.Hover(buildDescribeMarkdown(expr, desc), range);
    }
}

