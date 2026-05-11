import * as assert from 'assert';
import {
    resolveExpressionBeforeCursor,
    resolveCallContext,
    resolveHoverExpression,
} from '../../exprResolver';

suite('resolveExpressionBeforeCursor', () => {
    test('dotted expression with prefix', () => {
        const line = 'foo.bar.ba';
        const r = resolveExpressionBeforeCursor(line, line.length);
        assert.deepStrictEqual(r, { base: 'foo.bar', prefix: 'ba', isBareName: false });
    });

    test('trailing dot — empty prefix', () => {
        const line = 'foo.bar.';
        const r = resolveExpressionBeforeCursor(line, line.length);
        assert.deepStrictEqual(r, { base: 'foo.bar', prefix: '', isBareName: false });
    });

    test('bare name', () => {
        const line = 'thing';
        const r = resolveExpressionBeforeCursor(line, line.length);
        assert.deepStrictEqual(r, { base: '', prefix: 'thing', isBareName: true });
    });

    test('captures expressions with balanced calls', () => {
        const line = 'foo().bar';
        const r = resolveExpressionBeforeCursor(line, line.length);
        assert.deepStrictEqual(r, { base: 'foo()', prefix: 'bar', isBareName: false });
    });

    test('captures chain ending with call and trailing dot', () => {
        const line = 'a.b[0].c.ref().';
        const r = resolveExpressionBeforeCursor(line, line.length);
        assert.deepStrictEqual(r, { base: 'a.b[0].c.ref()', prefix: '', isBareName: false });
    });

    test('stops at unbalanced open paren', () => {
        const line = 'print(foo.bar';
        const r = resolveExpressionBeforeCursor(line, line.length);
        assert.deepStrictEqual(r, { base: 'foo', prefix: 'bar', isBareName: false });
    });

    test('subscription is allowed', () => {
        const line = 'arr[0].x';
        const r = resolveExpressionBeforeCursor(line, line.length);
        assert.deepStrictEqual(r, { base: 'arr[0]', prefix: 'x', isBareName: false });
    });

    test('cursor mid-line', () => {
        const line = 'print(foo.bar) # tail';
        const r = resolveExpressionBeforeCursor(line, 'print(foo.bar'.length);
        assert.deepStrictEqual(r, { base: 'foo', prefix: 'bar', isBareName: false });
    });

    test('empty token at start of line', () => {
        const r = resolveExpressionBeforeCursor('', 0);
        assert.strictEqual(r, undefined);
    });
});

suite('resolveCallContext', () => {
    test('open paren with no args yet', () => {
        const line = 'foo.bar(';
        const r = resolveCallContext(line, line.length);
        assert.deepStrictEqual(r, { callee: 'foo.bar', activeParameter: 0 });
    });

    test('after first comma', () => {
        const line = 'foo(a, ';
        const r = resolveCallContext(line, line.length);
        assert.deepStrictEqual(r, { callee: 'foo', activeParameter: 1 });
    });

    test('comma inside nested parens does not advance', () => {
        const line = 'foo(g(1, 2), ';
        const r = resolveCallContext(line, line.length);
        assert.deepStrictEqual(r, { callee: 'foo', activeParameter: 1 });
    });

    test('comma inside list does not advance', () => {
        const line = 'foo([1, 2], ';
        const r = resolveCallContext(line, line.length);
        assert.deepStrictEqual(r, { callee: 'foo', activeParameter: 1 });
    });

    test('not inside any call', () => {
        const r = resolveCallContext('x = 1', 5);
        assert.strictEqual(r, undefined);
    });

    test('comma inside string literal does not advance', () => {
        const line = 'foo("a, b", ';
        const r = resolveCallContext(line, line.length);
        assert.deepStrictEqual(r, { callee: 'foo', activeParameter: 1 });
    });
});

suite('resolveHoverExpression', () => {
    test('plain identifier', () => {
        const r = resolveHoverExpression('print(foo)', { start: 6, end: 9 });
        assert.strictEqual(r, 'foo');
    });

    test('dotted', () => {
        const r = resolveHoverExpression('a.b.c', { start: 0, end: 5 });
        assert.strictEqual(r, 'a.b.c');
    });

    test('accepts chained calls', () => {
        const r = resolveHoverExpression('foo().bar', { start: 0, end: 9 });
        assert.strictEqual(r, 'foo().bar');
    });

    test('refuses leading digit', () => {
        const r = resolveHoverExpression('1abc', { start: 0, end: 4 });
        assert.strictEqual(r, undefined);
    });
});
