"""Function extraction — FUNCTION/METHOD nodes + metadata.calls + ormOps.

The scope rule lives here: calls inside nested functions belong to the
inner function, not the outer one.

ORM call patterns are COLLECTED here at parse time (one AST walk) and
RESOLVED later by edges/orm_edges.py via lookup maps — no re-parsing.
"""
from __future__ import annotations
import ast
from typing import NamedTuple

from ..contract import code_node

NESTED_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)
COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)

# ── callOrder/v1 scheduler tables (docs/CALL_ORDER.md §4.2) ─────────────
# Matched on the LAST name segment so `from threading import Timer` and
# `threading.Timer(...)` classify alike — the same name-based heuristic the rest
# of the extractor uses (no type info at parse time).
TIMER_CALLS = {"call_later", "call_at", "Timer"}
PROMISE_CALLS = {"create_task", "ensure_future", "gather"}
EVENT_CALLS = {"signal", "add_signal_handler"}
CONC_CALLS = {"Thread", "ThreadPoolExecutor", "ProcessPoolExecutor",
              "to_thread", "run_in_executor"}


def _scheduler(name: str) -> tuple[str | None, bool, bool]:
    """(defer, conc, defers_its_arguments) for a scheduler call, else
    (None, False, False). `defers_its_arguments` is False for timers and event
    registrations: their delay/signal argument is evaluated inline and the
    deferred piece is a callback we never walk into."""
    leaf = name.rsplit(".", 1)[-1]
    if leaf in TIMER_CALLS:
        return "timer", False, False
    if leaf in PROMISE_CALLS:
        return "promise", True, True
    if leaf in EVENT_CALLS:
        return "event", False, False
    if leaf in CONC_CALLS:
        return None, True, True
    return None, False, False


class _SiteContext(NamedTuple):
    """Execution-region facts accumulated on the way down the walk; a call site
    only has to read the tuple it was reached with."""
    scope: str = "inline"
    enclosing_order: int | None = None
    awaited: bool = False
    defer: str | None = None
    defer_detail: str | None = None
    conc: bool = False
    repeat: bool = False
    maybe: bool = False

# ── ORM patterns (parse-time facts; resolution lives in edges/orm_edges.py) ──
DJANGO_QUERY_METHODS = {
    "get", "filter", "all", "exclude", "first", "last", "count", "exists",
    "values", "values_list", "only", "defer", "select_related",
    "prefetch_related", "aggregate", "annotate", "distinct", "order_by",
    "reverse", "raw", "iterator", "latest", "earliest", "in_bulk",
}
DJANGO_WRITE_METHODS = {
    "create", "update", "get_or_create", "update_or_create",
    "bulk_create", "bulk_update", "delete",
}
SQLA_STATEMENT_FUNCS = {"select", "insert", "update", "delete"}
SESSION_MUTATORS = {"add", "add_all", "merge", "delete"}   # session.add(obj) etc.
INSTANCE_MUTATORS = {"save", "delete"}                     # obj.save() / obj.delete()


def _walk_scope(body: list[ast.stmt], visit) -> None:
    """Walk statements, applying the scope rule (never descend into nested
    FunctionDef/ClassDef/Lambda). Shared by extract_calls + extract_orm_ops."""
    def walk(node: ast.AST) -> None:
        if isinstance(node, NESTED_SCOPES):
            return
        visit(node)
        for child in ast.iter_child_nodes(node):
            walk(child)
    for stmt in body:
        walk(stmt)


def call_name(func: ast.AST) -> str | None:
    """'foo()' → 'foo' · 'obj.method()' → 'obj.method' · 'requests.get()' → 'requests.get'.
    Subscript callees (foo[0]()) and other exotic forms → None."""
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        parts: list[str] = []
        node = func
        while isinstance(node, ast.Attribute):
            parts.append(node.attr)
            node = node.value
        if isinstance(node, ast.Name):
            parts.append(node.id)
            return ".".join(reversed(parts))
    return None


def extract_calls(body: list[ast.stmt]) -> list[str]:
    """Collect every called name in a function body, deduped."""
    return extract_calls_with_sites(body)[0]


def _infer_arg_type(arg: ast.AST) -> str:
    """Cheap literal arg-type tag in the same vocabulary as parameter
    annotations (str/int/bool/list/dict); anything else stays unknown."""
    if isinstance(arg, ast.Constant):
        if isinstance(arg.value, bool):
            return "bool"
        if isinstance(arg.value, str):
            return "str"
        if isinstance(arg.value, (int, float)):
            return "int" if isinstance(arg.value, int) else "float"
        return "unknown"
    if isinstance(arg, ast.JoinedStr):
        return "str"
    if isinstance(arg, ast.List):
        return "list"
    if isinstance(arg, ast.Dict):
        return "dict"
    if isinstance(arg, ast.Tuple):
        return "tuple"
    return "unknown"


def _arg_shape(node: ast.Call) -> tuple[list[str], bool, int]:
    """(argTypes, hasSpread, argCount). argCount counts positional args + keyword
    args; *args/**kwargs set hasSpread (runtime arity unknowable)."""
    arg_types: list[str] = []
    has_spread = False
    for a in node.args:
        if isinstance(a, ast.Starred):
            has_spread = True
            arg_types.append("unknown")
        else:
            arg_types.append(_infer_arg_type(a))
    for kw in node.keywords:
        if kw.arg is None:              # **kwargs
            has_spread = True
            arg_types.append("unknown")
        else:
            arg_types.append(_infer_arg_type(kw.value))
    return arg_types, has_spread, len(node.args) + len(node.keywords)


def _comprehension_children(node: ast.AST, ctx: _SiteContext) -> list[tuple[ast.AST, _SiteContext]]:
    """A comprehension body is an iteration callback (scope "callback",
    repeat); only the first iterable is evaluated in the enclosing frame."""
    callback = ctx._replace(scope="callback", repeat=True)
    if isinstance(node, ast.DictComp):
        children: list[tuple[ast.AST, _SiteContext]] = [
            (node.key, callback), (node.value, callback)]
    else:
        children = [(node.elt, callback)]
    for i, generator in enumerate(node.generators):
        children.append((generator.target, callback))
        children.append((generator.iter, ctx if i == 0 else callback))
        children.extend((cond, callback) for cond in generator.ifs)
    return children


def _children_with_context(node: ast.AST, ctx: _SiteContext) -> list[tuple[ast.AST, _SiteContext]]:
    """(child, context) pairs in source order. This is where the callOrder flags
    come from: loop bodies repeat, branch bodies may be skipped, except bodies
    may be skipped, finally bodies run at frame exit, comprehension bodies are
    iteration callbacks, an await operand is awaited."""
    if isinstance(node, COMPREHENSIONS):
        return _comprehension_children(node, ctx)
    if isinstance(node, (ast.For, ast.AsyncFor)):
        repeated = ctx._replace(repeat=True)
        return ([(node.target, ctx), (node.iter, ctx)]
                + [(s, repeated) for s in node.body]
                + [(s, repeated) for s in node.orelse])
    if isinstance(node, ast.While):
        repeated = ctx._replace(repeat=True)
        return ([(node.test, ctx)]
                + [(s, repeated) for s in node.body]
                + [(s, repeated) for s in node.orelse])
    if isinstance(node, ast.If):
        maybe = ctx._replace(maybe=True)           # test always runs
        return ([(node.test, ctx)]
                + [(s, maybe) for s in node.body]
                + [(s, maybe) for s in node.orelse])
    if isinstance(node, ast.IfExp):
        maybe = ctx._replace(maybe=True)
        return [(node.test, ctx), (node.body, maybe), (node.orelse, maybe)]
    if isinstance(node, ast.BoolOp):
        # `and`/`or`: every operand after the first is short-circuitable
        maybe = ctx._replace(maybe=True)
        if not node.values:
            return []
        return [(node.values[0], ctx)] + [(v, maybe) for v in node.values[1:]]
    if isinstance(node, (ast.Try, ast.TryStar)):
        # try body runs (doc §2 earlyExit: it is the calls AFTER a throwing
        # statement that may not run); except bodies may not run at all.
        maybe = ctx._replace(maybe=True)
        on_return = ctx._replace(defer=ctx.defer or "onReturn",
                                 defer_detail=ctx.defer_detail or "finally")
        return ([(s, ctx) for s in node.body]
                + [(h, maybe) for h in node.handlers]
                + [(s, ctx) for s in node.orelse]
                + [(s, on_return) for s in node.finalbody])
    if isinstance(node, ast.Match):
        maybe = ctx._replace(maybe=True)            # subject always evaluates
        return [(node.subject, ctx)] + [(case, maybe) for case in node.cases]
    if isinstance(node, ast.Await):
        return [(node.value, ctx._replace(awaited=True))]
    return [(child, ctx) for child in ast.iter_child_nodes(node)]


def _call_record(node: ast.Call, name: str, order: int, kind: str,
                 ctx: _SiteContext) -> tuple[dict, _SiteContext]:
    """One call-site record for one occurrence + the context its own children
    inherit."""
    arg_types, has_spread, arg_count = _arg_shape(node)
    site: dict = {"name": name, "argCount": arg_count, "argTypes": arg_types}
    if has_spread:
        site["hasSpread"] = True
    site["kind"] = kind
    site["order"] = order
    site["line"] = node.lineno
    site["col"] = node.col_offset
    if ctx.enclosing_order is not None:
        site["nested"] = ctx.enclosing_order
    site["scope"] = ctx.scope
    if ctx.awaited:
        site["awaited"] = True

    defer, conc, defers_arguments = _scheduler(name)
    site_defer = ctx.defer or defer
    site_conc = ctx.conc or conc
    if site_defer:
        site["defer"] = site_defer
    if site_conc:
        site["conc"] = True
    detail = ctx.defer_detail or (name if (defer or conc) else None)
    if detail and (site_defer or site_conc):
        site["deferDetail"] = detail
    if ctx.repeat:
        site["repeat"] = True
    if ctx.maybe:
        site["maybe"] = True

    children = ctx._replace(enclosing_order=order, awaited=False)
    if defers_arguments and (defer or conc):
        # the scheduler defers/parallelises this call's arguments — they inherit
        # it (asyncio.gather(a(), b()) → both promise + conc).
        children = children._replace(defer=ctx.defer or defer,
                                     defer_detail=ctx.defer_detail or name,
                                     conc=ctx.conc or conc)
    return site, children


def extract_calls_with_sites(body: list[ast.stmt], module_scope: bool = False
                             ) -> tuple[list[str], list[dict]]:
    """ONE scope-guarded walk producing both outputs: the legacy deduped call
    name list and one structured call-site record PER OCCURRENCE.

    The recorded set is frozen (docs/CALL_ORDER.md §5): this walk descends into
    exactly the same nodes `_walk_scope` does — never into nested defs, classes
    or lambdas — and only attaches callOrder/v1 metadata (order, line, col,
    nested, scope, awaited, defer, deferDetail, conc, repeat, maybe).
    `module_scope` marks a FILE owner: every site then reads scope "module".
    Hooks (use* callees) are recorded in the flow but excluded from the name
    list, exactly as metadata.calls has always been (§2 kind)."""
    calls: list[str] = []
    sites: list[dict] = []
    root = _SiteContext(scope="module" if module_scope else "inline")
    stack: list[tuple[ast.AST, _SiteContext]] = [
        (stmt, root) for stmt in reversed(body)]
    while stack:
        node, ctx = stack.pop()
        if isinstance(node, NESTED_SCOPES):
            continue
        children_ctx = ctx
        if isinstance(node, ast.Call):
            name = call_name(node.func)
            if name:
                kind = "hook" if name.rsplit(".", 1)[-1].startswith("use") else "call"
                site, children_ctx = _call_record(node, name, len(sites) + 1, kind, ctx)
                sites.append(site)
                if kind == "call" and name not in calls:
                    calls.append(name)
            else:
                children_ctx = ctx._replace(enclosing_order=None)
        stack.extend(reversed(_children_with_context(node, children_ctx)))
    return calls, sites


def _param_records(node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[dict]:
    """Typed parameter records {name, type, isOptional?, isRest?} for arity and
    type-shape matching. vararg/kwarg ride as isRest entries; defaults mark
    isOptional. Annotation text is the type vocabulary used by callSites."""
    records: list[dict] = []
    a = node.args
    positional = a.posonlyargs + a.args
    defaults = a.defaults                       # aligns with positional[-len(defaults):]
    kw_defaults = a.kw_defaults                 # aligns with kwonlyargs (None = required)

    def record(arg: ast.arg, optional: bool, rest: bool) -> None:
        rec: dict = {"name": arg.arg,
                     "type": ast.unparse(arg.annotation) if arg.annotation else "unknown"}
        if rest:
            rec["isRest"] = True
        if optional:
            rec["isOptional"] = True
        records.append(rec)

    offset = len(positional) - len(defaults)
    for i, arg in enumerate(positional):
        record(arg, i >= offset, False)
    # kwonly: kw_defaults aligns 1:1 with kwonlyargs (None = required)
    for i, arg in enumerate(a.kwonlyargs):
        record(arg, kw_defaults[i] is not None, False)
    if a.vararg:
        record(a.vararg, False, True)
    if a.kwarg:
        record(a.kwarg, False, True)
    return records


def _match_orm_call(call: ast.Call) -> dict | None:
    """One Call → ORM op dict {kind, pattern, target?, arg?, root?} or None.

    Patterns:
      X.objects.<query|write>(...)      django_objects   (target = X)
      var.query(X)                      sqlalchemy_query (target = X)
      var.get(X, pk)                    session_get      (target = X)
      var.add/delete/merge(X)           session_mutate   (arg = instance var)
      inst.save()/delete()              instance_mutate  (arg = var, heuristic)
      select/insert/update/delete(X)    sqlalchemy_<fn>  (root verified at resolve)
    """
    func = call.func

    # X.objects.<method>(...) — Django ORM queryset/manager
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Attribute) \
            and func.value.attr == "objects" and isinstance(func.value.value, ast.Name):
        m = func.attr
        if m in DJANGO_QUERY_METHODS:
            return {"kind": "read", "pattern": "django_objects", "target": func.value.value.id}
        if m in DJANGO_WRITE_METHODS:
            return {"kind": "write", "pattern": "django_objects", "target": func.value.value.id}
        return None

    # var.<attr>(...) — session / instance patterns
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
        var, m = func.value.id, func.attr
        if m == "query" and call.args and isinstance(call.args[0], ast.Name):
            return {"kind": "read", "pattern": "sqlalchemy_query", "target": call.args[0].id}
        if m == "get" and len(call.args) >= 2 and isinstance(call.args[0], ast.Name):
            return {"kind": "read", "pattern": "session_get", "target": call.args[0].id}
        if m in SESSION_MUTATORS and call.args and isinstance(call.args[0], ast.Name):
            return {"kind": "write", "pattern": "session_mutate", "arg": call.args[0].id}
        if m in INSTANCE_MUTATORS and not call.args:
            return {"kind": "write", "pattern": "instance_mutate", "arg": var}
        return None

    # select(X) / insert(X) / update(X) / delete(X) — SQLAlchemy 2.0 statements
    if isinstance(func, ast.Name) and func.id in SQLA_STATEMENT_FUNCS \
            and call.args and isinstance(call.args[0], ast.Name):
        kind = "read" if func.id == "select" else "write"
        return {"kind": kind, "pattern": f"sqlalchemy_{func.id}",
                "target": call.args[0].id, "root": func.id}
    return None


def extract_orm_ops(body: list[ast.stmt]) -> list[dict]:
    """Collect ORM access patterns in a function body (scope-guarded)."""
    ops: list[dict] = []

    def visit(node: ast.AST) -> None:
        if isinstance(node, ast.Call):
            op = _match_orm_call(node)
            if op:
                ops.append(op)

    _walk_scope(body, visit)
    return ops


def extract_function(node: ast.FunctionDef | ast.AsyncFunctionDef, rel_path: str,
                     source: str, parent_class: str | None = None) -> dict:
    is_async = isinstance(node, ast.AsyncFunctionDef)
    name = f"{parent_class}.{node.name}" if parent_class else node.name

    raw = ast.get_source_segment(source, node) or ""
    params = [a.arg for a in node.args.posonlyargs + node.args.args + node.args.kwonlyargs]
    decorators = [ast.unparse(d) for d in node.decorator_list]
    calls, call_sites = extract_calls_with_sites(node.body)

    # hasErrorHandling/throws use ast.walk deliberately — mirrors the JS
    # extractor, which scans the whole function subtree for try/raise.
    metadata = {
        "params": params,
        "parameters": _param_records(node),
        "calls": calls,
        "callSites": call_sites,
        "ormOps": extract_orm_ops(node.body),
        "isAsync": is_async,
        "hasErrorHandling": any(isinstance(n, (ast.Try, ast.TryStar)) for n in ast.walk(node)),
        "throws": any(isinstance(n, ast.Raise) for n in ast.walk(node)),
        "lineCount": (node.end_lineno or node.lineno) - node.lineno,
        "decorators": decorators,
    }
    if parent_class:
        metadata["parentClass"] = parent_class

    return code_node(
        rel_path, name,
        "METHOD" if parent_class else "FUNCTION",
        node.lineno, node.end_lineno or node.lineno, raw, metadata,
    )
