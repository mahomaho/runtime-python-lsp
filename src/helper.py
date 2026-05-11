"""Runtime introspection helper injected into the debuggee.

Stashed in sys.modules['_lsp_helper']. Two public entry points:

  introspect(obj) -> JSON list of attribute info  (for completions)
  describe(obj)   -> JSON object describing obj   (for hovers)
"""

import inspect
import json
import sys


def _safe_repr(x, limit=200):
    try:
        r = repr(x)
        return r if len(r) <= limit else r[: limit - 3] + '...'
    except Exception:
        return '<unrepresentable %s>' % type(x).__name__


def _get_doc(obj, may_call=False):
    """Fetch the docstring. If `may_call` and __doc__ is callable, invoke it."""
    try:
        d = getattr(obj, '__doc__', None)
    except Exception:
        return ''
    if d is None:
        return ''
    if callable(d):
        if not may_call:
            return ''
        try:
            d = d()
        except Exception:
            return ''
    return d if isinstance(d, str) else (str(d) if d else '')


def _callable_kind(val):
    if inspect.isclass(val):
        return 'class'
    if inspect.ismethod(val):
        return 'method'
    if inspect.isfunction(val):
        return 'function'
    if inspect.isbuiltin(val):
        return 'builtin'
    return 'callable'


def _signature_info(val):
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


def introspect(obj):
    out = []
    try:
        names = obj.__dir__()
    except Exception:
        names = dir(obj)
    for name in names:
        info = {'name': name}
        try:
            val = getattr(obj, name)
        except Exception as e:
            info['kind'] = 'attribute'
            info['error'] = type(e).__name__
            out.append(info)
            continue

        info['doc'] = _get_doc(val)
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


def describe(obj):
    info = {'type': type(obj).__name__}
    info['doc'] = _get_doc(obj, may_call=True)
    info['repr'] = _safe_repr(obj, limit=500)

    try:
        qualname = getattr(obj, '__qualname__', None)
        if isinstance(qualname, str):
            info['qualname'] = qualname
    except Exception:
        pass
    try:
        module = getattr(obj, '__module__', None)
        if isinstance(module, str):
            info['module'] = module
    except Exception:
        pass

    try:
        bound_self = getattr(obj, '__self__', None)
        if bound_self is not None:
            info['bound_to'] = type(bound_self).__name__
    except Exception:
        pass

    if inspect.isclass(obj):
        try:
            info['mro'] = [c.__name__ for c in obj.__mro__ if c is not object]
        except Exception:
            pass

    sig = None
    if callable(obj):
        try:
            sig = inspect.signature(obj)
            info['signature'] = str(sig)
        except (ValueError, TypeError):
            pass
        info['callable_kind'] = _callable_kind(obj)

    if sig is not None and not inspect.isclass(obj):
        try:
            required = [
                p for p in sig.parameters.values()
                if p.default is p.empty
                and p.kind not in (p.VAR_POSITIONAL, p.VAR_KEYWORD)
            ]
            if not required:
                try:
                    result = obj()
                    info['call_result_repr'] = _safe_repr(result, limit=2000)
                    info['call_result_type'] = type(result).__name__
                except Exception as e:
                    info['call_error'] = '%s: %s' % (type(e).__name__, e)
        except Exception:
            pass

    try:
        info['source_file'] = inspect.getsourcefile(obj)
        info['source_line'] = inspect.getsourcelines(obj)[1]
    except (TypeError, OSError):
        pass
    except Exception:
        pass

    return json.dumps(info)


sys.modules['_lsp_helper'] = sys.modules[__name__]
