"""Function extraction — FUNCTION/METHOD nodes + metadata.calls + ormOps.

The scope rule lives here: calls inside nested functions belong to the
inner function, not the outer one.

ORM call patterns are COLLECTED here at parse time (one AST walk) and
RESOLVED later by edges/orm_edges.py via lookup maps — no re-parsing.
"""
from __future__ import annotations
import ast

from ..contract import code_node

NESTED_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)

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


def extract_calls_with_sites(body: list[ast.stmt]) -> tuple[list[str], list[dict]]:
    """ONE scope-guarded walk producing both outputs: the legacy deduped call
    name list and structured call sites {name, argCount, argTypes, hasSpread}.
    argCount counts positional args + keyword args; *args/**kwargs set
    hasSpread (runtime arity unknowable). One record per
    (name, argCount, argTypes) triple so same-arity different-type call sites
    both survive (each can hit a different overload sibling)."""
    calls: list[str] = []
    sites: list[dict] = []
    seen_sites: set[str] = set()

    def visit(node: ast.AST) -> None:
        if not isinstance(node, ast.Call):
            return
        name = call_name(node.func)
        if not name:
            return
        if name not in calls:
            calls.append(name)

        arg_types: list[str] = []
        has_spread = False
        for a in node.args:
            if isinstance(a, ast.Starred):
                has_spread = True
                arg_types.append("unknown")
            else:
                arg_types.append(_infer_arg_type(a))
        for kw in node.keywords:
            if kw.arg is None:          # **kwargs
                has_spread = True
                arg_types.append("unknown")
            else:
                arg_types.append(_infer_arg_type(kw.value))

        arg_count = len(node.args) + len(node.keywords)
        key = f"{name}/{arg_count}/{','.join(arg_types)}"
        if key in seen_sites:
            return
        seen_sites.add(key)
        site = {"name": name, "argCount": arg_count, "argTypes": arg_types}
        if has_spread:
            site["hasSpread"] = True
        sites.append(site)

    _walk_scope(body, visit)
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
