import * as vscode from 'vscode';
import { DescribeResult } from './introspectTypes';

export function buildDescribeMarkdown(expr: string, desc: DescribeResult): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportHtml = true;
    md.isTrusted = false;

    const isCallable = !!desc.callable_kind;
    if (isCallable && desc.signature) {
        md.appendCodeblock(`${expr}${desc.signature}`, 'python');
    } else {
        md.appendCodeblock(expr, 'python');
    }

    if (desc.repr && desc.repr !== desc.type) {
        md.appendMarkdown('\n\n');
        md.appendCodeblock(desc.repr, 'python');
    }

    if (isCallable) {
        if (desc.call_result_repr !== undefined) {
            const t = desc.call_result_type ?? 'object';
            md.appendMarkdown(`\n\n${escapeHtml(expr)}() → \`${escapeHtml(t)}\`\n\n`);
            md.appendCodeblock(desc.call_result_repr, 'python');
        } else if (desc.call_error) {
            md.appendMarkdown(`\n\n${escapeHtml(expr)}() raised:\n\n`);
            md.appendCodeblock(desc.call_error, 'python');
        }
    }

    if (desc.doc && desc.doc.trim().length > 0) {
        md.appendMarkdown('\n\n---\n\n');
        md.appendMarkdown(toItalic(desc.doc));
    }

    if (desc.source_file) {
        const loc = desc.source_line ? `${desc.source_file}:${desc.source_line}` : desc.source_file;
        md.appendMarkdown(`\n\n<sub>Defined in ${escapeHtml(loc)}</sub>`);
    }

    return md;
}

function toItalic(doc: string): string {
    // Plain-markdown italic per paragraph (single-line spans inside paragraphs use
    // a trailing backslash for soft line breaks). Avoids HTML support quirks.
    const escaped = escapeMarkdownInline(doc.replace(/\r\n/g, '\n'));
    const paragraphs = escaped.split(/\n\n+/);
    return paragraphs
        .map((p) => '*' + p.replace(/\n/g, '*  \n*') + '*')
        .join('\n\n');
}

function escapeMarkdownInline(s: string): string {
    return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
