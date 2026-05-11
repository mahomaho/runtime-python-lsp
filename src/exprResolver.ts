/**
 * Extracts the dotted/indexed/called expression to the left of a cursor.
 *
 * Walks backwards over identifier chars, dots, and balanced [] / () groups.
 * Function calls are *included* — caller is opting in to re-evaluating them.
 */

const IDENT_RE = /[A-Za-z_0-9]/;

export interface ResolvedExpression {
    /** The expression without the trailing dot, e.g. "foo.bar" for "foo.bar." */
    base: string;
    /** Identifier prefix typed after the dot, e.g. "ba" for "foo.ba". */
    prefix: string;
    /** True if the expression is a bare name (no leading dot context). */
    isBareName: boolean;
}

/**
 * Walk backwards from `cursor` over a Python attribute-access expression.
 * Returns the start index of the expression in `line`, or `cursor` if no
 * expression characters precede.
 */
export function walkBackExpression(line: string, cursor: number): number {
    let i = cursor;
    while (i > 0) {
        const c = line[i - 1];
        if (IDENT_RE.test(c) || c === '.') {
            i--;
        } else if (c === ']' || c === ')') {
            const open = c === ']' ? '[' : '(';
            let depth = 1;
            let j = i - 2;
            while (j >= 0 && depth > 0) {
                if (line[j] === c) depth++;
                else if (line[j] === open) depth--;
                if (depth > 0) j--;
            }
            if (depth !== 0) break;
            i = j;
        } else {
            break;
        }
    }
    return i;
}

export function resolveExpressionBeforeCursor(line: string, cursor: number): ResolvedExpression | undefined {
    const start = walkBackExpression(line, cursor);
    const token = line.slice(start, cursor);
    if (token.length === 0) return undefined;

    const dotIdx = lastTopLevelDot(token);
    if (dotIdx < 0) {
        if (!/^[A-Za-z_]/.test(token)) return undefined;
        return { base: '', prefix: token, isBareName: true };
    }

    const base = token.slice(0, dotIdx);
    const prefix = token.slice(dotIdx + 1);
    if (base.length === 0) return undefined;
    return { base, prefix, isBareName: false };
}

/**
 * Index of the last `.` in `token` that is not nested inside [] or ().
 */
function lastTopLevelDot(token: string): number {
    let depthParen = 0;
    let depthBracket = 0;
    for (let i = token.length - 1; i >= 0; i--) {
        const c = token[i];
        if (c === ')') depthParen++;
        else if (c === '(') depthParen--;
        else if (c === ']') depthBracket++;
        else if (c === '[') depthBracket--;
        else if (c === '.' && depthParen === 0 && depthBracket === 0) return i;
    }
    return -1;
}

export function resolveHoverExpression(line: string, range: { start: number; end: number }): string | undefined {
    const expr = line.slice(range.start, range.end);
    if (expr.length === 0) return undefined;
    if (!/^[A-Za-z_]/.test(expr)) return undefined;
    return expr;
}

/**
 * Find the open paren whose call this cursor is inside, and return
 * the callable expression to its left plus the comma index of the cursor.
 */
export interface CallContext {
    callee: string;
    activeParameter: number;
}

export function resolveCallContext(line: string, cursor: number): CallContext | undefined {
    let depthParen = 0;
    let depthBracket = 0;
    let depthBrace = 0;
    let inString: string | null = null;
    let openParen = -1;
    for (let i = cursor - 1; i >= 0; i--) {
        const c = line[i];
        if (inString) {
            if (c === inString && line[i - 1] !== '\\') inString = null;
            continue;
        }
        if (c === '"' || c === "'") {
            inString = c;
            continue;
        }
        if (c === ')') depthParen++;
        else if (c === ']') depthBracket++;
        else if (c === '}') depthBrace++;
        else if (c === '(') {
            if (depthParen === 0) {
                openParen = i;
                break;
            }
            depthParen--;
        } else if (c === '[') {
            depthBracket = Math.max(0, depthBracket - 1);
        } else if (c === '{') {
            depthBrace = Math.max(0, depthBrace - 1);
        }
    }
    if (openParen < 0) return undefined;

    let activeParameter = 0;
    {
        let dp = 0, db = 0, dc = 0;
        let inStr: string | null = null;
        for (let i = openParen + 1; i < cursor; i++) {
            const c = line[i];
            if (inStr) {
                if (c === inStr && line[i - 1] !== '\\') inStr = null;
                continue;
            }
            if (c === '"' || c === "'") {
                inStr = c;
                continue;
            }
            if (c === '(') dp++;
            else if (c === ')') dp--;
            else if (c === '[') db++;
            else if (c === ']') db--;
            else if (c === '{') dc++;
            else if (c === '}') dc--;
            else if (c === ',' && dp === 0 && db === 0 && dc === 0) activeParameter++;
        }
    }

    const j = walkBackExpression(line, openParen);
    const callee = line.slice(j, openParen);
    if (callee.length === 0) return undefined;
    return { callee, activeParameter };
}
