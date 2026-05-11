# Runtime-Aware Python LSP

A VS Code extension that augments Python language support with **live, runtime-driven** completions, signature help, and hovers — sourced from a **paused Python debug session** via the Debug Adapter Protocol.

When you set a breakpoint and the debugger pauses, this extension introspects the *actual* Python objects sitting on the stack and surfaces what `dir(obj)`, `getattr(obj, name)`, and `inspect.signature(obj)` can see — including dynamically generated attributes, proxies, and AUTOSAR-style getters that Pylance can never know about because they only exist at runtime.

It runs **alongside** Pylance, not instead of it.

---

## Why this exists

Static type checkers can't see attributes that come from runtime metaprogramming. If your codebase has objects like:

```python
class EcucContainerValue:
    def __getattr__(self, name):
        # resolves children dynamically from a model loaded at runtime
        ...
```

…then Pylance's autocomplete on `myContainer.` is empty. But if your debugger is paused inside a function holding a real `EcucContainerValue` instance, the actual children *are* discoverable via `dir()` — and that's what this extension uses.

## Features

- **Completions** at `foo.bar.<cursor>` from a paused frame's value, including chains through function calls (`foo.bar.ref().<cursor>`)
- **Bare-name completions** for locals and globals walked from the call stack
- **Signature help** for the actual callable object, including correct parameter names from `inspect.signature`
- **Hover tooltips** with:
  - Signature or `expr: Type` code block
  - Repr of the value
  - Result of calling the function (auto-invoked when the callable takes no required arguments)
  - Italic docstring (calls `__doc__()` if it's a callable that produces docs lazily)
  - Source file:line if available
- **Rich tooltip on completion items** — the same hover-style markdown also appears in the suggestion details panel (expand it with `Ctrl+Space`)
- **Suppresses VS Code's debug variable hover** so the language hover (this extension + Pylance) shows without needing `Alt`

## How it works

1. A `DebugAdapterTracker` registered for `python` / `debugpy` listens for `stopped` / `continued` DAP events to know when a session is paused.
2. On the first hover/completion in a paused session, a tiny Python helper module is injected into the debuggee via a single `evaluate` call (base64-encoded, force-replaces any prior version when the source changes).
3. The helper exposes `introspect(obj)` (for completions) and `describe(obj)` (for hovers). Their JSON output is base64-encoded and returned through DAP.
4. Frame selection prefers the topmost frame whose `source.path` matches the active document; falls back to the topmost frame.
5. Results are cached per `(sessionId, frameId, expression)` and dropped on `continued` / `stopped` / session termination.

When no debug session is paused, the providers no-op and Pylance handles everything.

## Requirements

- VS Code 1.85 or newer
- Microsoft's [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python) (provides debugpy)
- A `.py` file open and a debug session **paused** at a breakpoint

## Settings

| Setting | Default | What it does |
|---------|---------|--------------|
| `runtimePythonLsp.evaluateTimeoutMs` | `5000` | Per-`evaluate` timeout in milliseconds. Bump if you have heavy AUTOSAR-style objects. |
| `runtimePythonLsp.trace.dap` | `false` | Logs verbose DAP events to the **Runtime Python LSP** output channel. |

## Caveats — re-running calls

This extension **does** evaluate function calls when introspecting:

- The hover auto-calls any zero-argument callable to display its return value.
- Completion on `foo.ref().<cursor>` re-runs `ref()` to discover the attributes of its result.
- The completion item details popup runs `describe()` on the focused item.

For getter-style methods this is exactly what you want. For methods with side effects (`delete_things()`), each hover or completion will re-execute them. **Use accordingly.**

## Limitations

- The "auto-call" only triggers for zero-required-argument callables. Methods that need parameters are not invoked automatically.
- The `EvaluatableExpressionProvider` registered for Python files suppresses VS Code's built-in debug variable hover. The **Variables** view in the Debug sidebar is unaffected.
- Bare-name completion uses DAP `scopes` + `variables`, not introspection — so it shows raw names without signatures or rich docs (use the suggestion details panel for the rich version).

## Building from source

```bash
npm install
npm run compile     # tsc + copies helper.py to out/
npm test            # downloads VS Code, runs the Mocha suite
```

To package a `.vsix`:

```bash
npx @vscode/vsce package --allow-missing-repository
```

To launch the extension in a development host: open this folder in VS Code and press `F5`.

## Project layout

```
src/
  extension.ts             - activate(), provider registration, DAP tracker
  debugBridge.ts           - DAP evaluate, helper injection, base64/JSON wire format
  sessionState.ts          - paused-session registry + helper hash tracking
  frameSelector.ts         - stack walking + frame picking
  exprResolver.ts          - text-before-cursor → expression (handles balanced () and [])
  completionProvider.ts    - dotted + bare-name completion, resolveCompletionItem
  signatureHelpProvider.ts - parameter-aware signature help
  hoverProvider.ts         - hover provider
  bareNameCompletion.ts    - DAP scopes + variables walk
  describeMarkdown.ts      - shared markdown builder for hover and completion docs
  cache.ts                 - per-frame caches for introspect/describe results
  helper.py                - injected into the debuggee
  test/                    - Mocha test suite
```

## License

MIT — see [LICENSE](LICENSE).
