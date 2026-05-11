# Runtime-Aware Python Language Server for VS Code

A VS Code extension that augments Python language support with **live, runtime-driven** completions, signature help, and hovers — sourced from a paused Python debug session via DAP.

This is a *supplemental* provider. It does not replace Pylance; it runs alongside it and contributes additional items based on what's actually in memory at the current breakpoint.

---

## High-level requirements

1. **Active only during paused Python debug sessions.** When no session is paused, the provider stays silent and Pylance handles everything.
2. **Use `dir(obj)` directly** to enumerate members — no filtering, no replacement of `__dir__`. Whatever `dir()` reports is what gets surfaced.
3. **Use the actual returned value** of each attribute to determine if it is callable and to extract its signature. Triggering property getters via `getattr` is acceptable.
4. **Support stack walking.** Completions and hovers must resolve names in the context of a specific stack frame, chosen by relevance (typically the frame matching the edited file/line).
5. **Provide rich completion items**, including:
   - Description text built from the object's docstring.
   - Signature info for callables, used both in the completion detail line and as a snippet with placeholders for required arguments.
6. **Provide hover tooltips** showing the docstring of the hovered object, plus type, signature, and repr where useful.

---

## Architecture

Three components:

1. **VS Code extension (TypeScript).**
   - Registers completion, signature help, and hover providers for Python.
   - Tracks debug session state via `DebugAdapterTracker` (listens for `stopped`/`continued` events).
   - Bridges between LSP-style providers and the Debug Adapter Protocol.

2. **Python helper module**, injected once per debug session into `sys.modules['_lsp_helper']`. Performs introspection inside the debuggee and returns JSON-serializable results.

3. **The user's paused debug session** (running under debugpy). The extension talks to it through standard DAP requests: `stackTrace`, `scopes`, `variables`, `evaluate`.

The language server does not need to be a separate process — VS Code's `CompletionItemProvider`, `SignatureHelpProvider`, and `HoverProvider` APIs are sufficient. Use a separate LSP only if there's a future need for diagnostics or other features beyond these three.

---

## Activation and lifecycle

- `activationEvents`: `onDebug`, `onLanguage:python`.
- Register a `DebugAdapterTrackerFactory` for `python` to observe DAP traffic.
- Mark the session as paused on `stopped` events; mark as resumed on `continued`.
- Inject the helper module on first need per session, keyed by session ID.
- Drop caches on `continued`, `stopped` (frame may have changed), and session termination.

Providers must gracefully no-op when no debug session is paused.

---

## Frame selection (stack walking)

When the user triggers completion or hover, pick a frame as follows:

1. Fetch threads → pick the stopped thread.
2. Fetch `stackTrace` for that thread.
3. **Preferred:** find the topmost frame whose `source.path` matches the active document and whose `line` is near the cursor.
4. **Fallback:** topmost frame on the stack.
5. Optionally honor VS Code's currently selected frame in the Call Stack pane (via `vscode.debug.activeStackItem` or by tracking variable-view requests in the adapter tracker).

For bare-name completion (cursor not preceded by a dot), walk up the stack: query `scopes` and `variables` for each frame and aggregate identifiers, tagging them with their frame of origin.

---

## Helper module

Inject once per session via `evaluate` with a context like `repl`. Stash in `sys.modules['_lsp_helper']` so subsequent calls are cheap.

Two entry points:

### `introspect(obj)` — for completions

```python
def introspect(obj):
    import inspect, json
    out = []
    for name in dir(obj):
        info = {'name': name}
        try:
            val = getattr(obj, name)
        except Exception as e:
            info['kind'] = 'attribute'
            info['error'] = type(e).__name__
            out.append(info)
            continue

        info['doc'] = (getattr(val, '__doc__', None) or '')
        info['type'] = type(val).__name__

        if callable(val):
            info['kind'] = _callable_kind(val)
            sig_info = _signature_info(val)
            if sig_info is not None:
                info.update(sig_info)
        else:
            info['kind'] = 'attribute'

        out.append(info)
    return json.dumps(out)


def _callable_kind(val):
    import inspect
    if inspect.isclass(val):       return 'class'
    if inspect.ismethod(val):      return 'method'
    if inspect.isfunction(val):    return 'function'
    if inspect.isbuiltin(val):     return 'builtin'
    return 'callable'


def _signature_info(val):
    import inspect
    try:
        sig = inspect.signature(val)
    except (ValueError, TypeError):
        return None
    params = []
    for p in sig.parameters.values():
        params.append({
            'name': p.name,
            'kind': p.kind.name,
            'default': _safe_repr(p.default) if p.default is not p.empty else None,
            'has_default': p.default is not p.empty,
            'annotation': _safe_repr(p.annotation) if p.annotation is not p.empty else None,
        })
    return {
        'signature': str(sig),
        'params': params,
        'return_annotation': (
            _safe_repr(sig.return_annotation)
            if sig.return_annotation is not sig.empty else None
        ),
    }


def _safe_repr(x):
    try:
        r = repr(x)
        return r if len(r) <= 200 else r[:197] + '...'
    except Exception:
        return f'<unrepresentable {type(x).__name__}>'
```

### `describe(obj)` — for hovers

```python
def describe(obj):
    import inspect, json
    info = {
        'type': type(obj).__name__,
        'doc': (getattr(obj, '__doc__', None) or ''),
    }
    try:
        r = repr(obj)
        info['repr'] = r if len(r) <= 500 else r[:497] + '...'
    except Exception:
        info['repr'] = f'<unrepresentable {type(obj).__name__}>'

    if callable(obj):
        try:
            info['signature'] = str(inspect.signature(obj))
        except (ValueError, TypeError):
            pass
        info['callable_kind'] = (
            'class'    if inspect.isclass(obj)    else
            'method'   if inspect.ismethod(obj)   else
            'function' if inspect.isfunction(obj) else
            'builtin'  if inspect.isbuiltin(obj)  else
            'callable'
        )

    try:
        info['source_file'] = inspect.getsourcefile(obj)
        info['source_line'] = inspect.getsourcelines(obj)[1]
    except (TypeError, OSError):
        pass

    return json.dumps(info)
```

---

## DAP integration

For each query:

```ts
const resp = await session.customRequest('evaluate', {
    expression: `__import__('sys').modules['_lsp_helper'].introspect(${expr})`,
    frameId,
    context: 'watch'   // 'hover' for hover provider
});
const info = JSON.parse(resp.result);
```

- Use `context: 'watch'` for completion/signature help.
- Use `context: 'hover'` for hover — debugpy treats this as side-effect-free and may refuse risky evaluations. That refusal is desirable; just return no hover.
- Apply a **timeout** (1–2s) on every DAP request and fail gracefully.
- Honor the provider's `CancellationToken` — abort if the user moves on.

---

## Expression resolution

For `foo.bar.<cursor>` style triggers, extract the expression to the left of the dot:

- Acceptable v1: walk backwards over `[\w.\[\]]+` from the cursor.
- Better: tokenize the line.
- Best: parse the document with `ast.parse` after replacing the trailing identifier with a sentinel, walk the AST to find the attribute target.

For hover, use `getWordRangeAtPosition(pos, /[\w.\[\]]+/)` to capture dotted/indexed expressions as a unit.

**Refuse to evaluate expressions containing function calls** (`foo().bar`) — re-running calls is unsafe. Return no completion in those cases.

---

## Completion provider

Register on language `python` with trigger character `.`.

For each item from `introspect`:

- `label`: the attribute name.
- `kind`: map from `info.kind` to `vscode.CompletionItemKind` (Method, Function, Class, Field, etc.).
- `detail`: `${name}${info.signature}` for callables; `${kind}: ${type}` otherwise.
- `documentation`: `MarkdownString` from `info.doc`. Truncate to first paragraph for the popup; full doc via `resolveCompletionItem`.
- `insertText`: snippet for callables — placeholders for required args only, skipping `self`/`cls` when leading, and skipping `*args`/`**kwargs`.

Mark items so users can tell they came from runtime introspection (e.g. `detail` suffix `(runtime)` or a distinguishing prefix).

---

## Signature help provider

Register on language `python` with trigger characters `(` and `,`.

- Resolve the callable expression under the cursor (find the open paren that contains the cursor, take the expression to its left).
- Reuse cached `introspect` data when possible; otherwise call the helper.
- Build `SignatureInformation` from `signature` + `params`.
- Compute `activeParameter` by counting top-level commas between the open paren and the cursor, ignoring commas inside nested `()`/`[]`/`{}`/strings.

---

## Hover provider

Register on language `python`.

- Use `getWordRangeAtPosition(pos, /[\w.\[\]]+/)` for the hovered expression.
- Pick a frame the same way as completion.
- Call `_lsp_helper.describe(expr)` with `context: 'hover'`.
- Build a `MarkdownString`:
  - Code block with `${expr}${signature}` for callables, or `${expr}: ${type}` otherwise.
  - Horizontal rule, then the docstring as markdown.
  - Repr in a code block for non-callables when it differs from the type name.
  - Source location footer (`*Defined in path:line*`) when available.
- Set `isTrusted = false`.
- If the hovered expression matches a member already in the completion cache, build the hover from the cached entry instead of round-tripping.

---

## Caching

- **Attribute cache:** `(sessionId, frameId, expression) → introspect result`.
- **Describe cache:** `(sessionId, frameId, expression) → describe result`.
- **Signature cache:** `(sessionId, frameId, callable_expression) → params`.
- Seed the signature cache from `introspect` results to avoid duplicate work.
- Invalidate all caches on `continued`, `stopped`, and session termination.
- Debounce hover events (50–100ms) since they fire on cursor motion.

---

## Error handling and edge cases

- `getattr` may raise even though `dir()` listed the name — record the error type, still surface the name in completions.
- `inspect.signature` may fail on builtins/C extensions — catch `ValueError`/`TypeError`, omit signature info.
- Property getters with side effects will run on every introspection — this is accepted, but the cache must absorb the cost.
- `evaluate` may fail or time out (e.g. paused inside `nogil` C code) — bail gracefully, return no items.
- Stale `stopped` events: track sequence numbers and discard results from outdated pause states.
- Unhandled cases (proxies, dynamically generated attrs only resolvable via `__getattr__`) are out of scope unless they show up via `dir()`.

---

## Suggested project layout

```
my-extension/
  package.json                    # contributes, activationEvents
  src/
    extension.ts                  # activate(), provider registration
    debugBridge.ts                # DAP client, helper injection, caching
    frameSelector.ts              # stack walking + frame picking
    exprResolver.ts               # text-before-cursor → expression
    completionProvider.ts
    signatureHelpProvider.ts
    hoverProvider.ts
    helper.py                     # injected into the debuggee
```

---

## Suggested build order

1. Bare extension that logs all DAP `stopped`/`continued` events.
2. Helper injection on first paused state per session.
3. Completion provider returning runtime members for a hardcoded expression.
4. Real expression resolver wired to completion.
5. Signature snippets in completion items.
6. Signature help provider.
7. Hover provider.
8. Stack walking for bare-name completion.
9. Caching, debouncing, cancellation polish.
