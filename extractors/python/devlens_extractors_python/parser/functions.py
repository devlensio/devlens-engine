"""Function extraction — FUNCTION/METHOD nodes + metadata.calls.

The scope rule lives here: calls inside nested functions belong to the
inner function, not the outer one.
"""
from __future__ import annotations
import ast
from ..contract import code_node

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
    """Collect every called name in a function body, deduped.

    THE SCOPE RULE: we do NOT descend into nested FunctionDef/ClassDef/
    Lambda — calls inside a nested function belong to that inner function,
    not to the one being extracted. ast.walk() would attribute them to the
    wrong node, so we walk manually with iter_child_nodes.
    """
    NESTED_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)
    calls: list[str] = []

    def visit(node: ast.AST) -> None:
        if isinstance(node, NESTED_SCOPES):
            return
        if isinstance(node, ast.Call):
            name = call_name(node.func)
            if name:
                calls.append(name)
        for child in ast.iter_child_nodes(node):
            visit(child)

    for stmt in body:
        visit(stmt)

    return list(dict.fromkeys(calls))   # dedupe, keep first-seen order



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
