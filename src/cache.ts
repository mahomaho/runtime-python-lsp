import { sessions } from './sessionState';
import { IntrospectItem, DescribeResult } from './introspectTypes';

interface FrameCacheEntries {
    introspect: Map<string, IntrospectItem[]>;
    describe: Map<string, DescribeResult>;
}

const cache = new Map<string, Map<number, FrameCacheEntries>>();

sessions.onChanged(() => {
    cache.clear();
});

function getFrameCache(sessionId: string, frameId: number): FrameCacheEntries {
    let perSession = cache.get(sessionId);
    if (!perSession) {
        perSession = new Map();
        cache.set(sessionId, perSession);
    }
    let entries = perSession.get(frameId);
    if (!entries) {
        entries = { introspect: new Map(), describe: new Map() };
        perSession.set(frameId, entries);
    }
    return entries;
}

export function getCachedIntrospect(
    sessionId: string,
    frameId: number,
    expression: string,
): IntrospectItem[] | undefined {
    return cache.get(sessionId)?.get(frameId)?.introspect.get(expression);
}

export function setCachedIntrospect(
    sessionId: string,
    frameId: number,
    expression: string,
    items: IntrospectItem[],
): void {
    getFrameCache(sessionId, frameId).introspect.set(expression, items);
}

export function getCachedDescribe(
    sessionId: string,
    frameId: number,
    expression: string,
): DescribeResult | undefined {
    return cache.get(sessionId)?.get(frameId)?.describe.get(expression);
}

export function setCachedDescribe(
    sessionId: string,
    frameId: number,
    expression: string,
    result: DescribeResult,
): void {
    getFrameCache(sessionId, frameId).describe.set(expression, result);
}

/** If `parentExpr.member` exists in introspect cache, synthesize a describe-like view. */
export function describeFromIntrospect(
    sessionId: string,
    frameId: number,
    parentExpr: string,
    member: string,
): DescribeResult | undefined {
    const items = getCachedIntrospect(sessionId, frameId, parentExpr);
    if (!items) return undefined;
    const item = items.find((i) => i.name === member);
    if (!item) return undefined;
    const result: DescribeResult = {
        type: item.type ?? 'object',
        doc: item.doc ?? '',
    };
    if (item.signature) result.signature = item.signature;
    if (item.kind && item.kind !== 'attribute') result.callable_kind = item.kind;
    return result;
}
