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
    calls: list[str] = []

    def visit(node: ast.AST) -> None:
        if isinstance(node, ast.Call):
            name = call_name(node.func)
            if name:
                calls.append(name)

    _walk_scope(body, visit)
    return list(dict.fromkeys(calls))   # dedupe, keep first-seen order


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

    # hasErrorHandling/throws use ast.walk deliberately — mirrors the JS
    # extractor, which scans the whole function subtree for try/raise.
    metadata = {
        "params": params,
        "calls": extract_calls(node.body),
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
