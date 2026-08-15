"""Class extraction — CLASS node + METHOD children."""
from __future__ import annotations

import ast

from ..contract import code_node
from .functions import extract_function

def extract_class(node: ast.ClassDef, rel_path: str, source: str,
                  prefix: str = "") -> list[dict]:
    """Returns [CLASS node, *METHOD nodes]. Nested classes get dotted names
    (Outer.Inner) and their methods (Outer.Inner.method) — same convention
    as methods."""
    class_name = f"{prefix}.{node.name}" if prefix else node.name
    raw = ast.get_source_segment(source, node) or ""

    children: list[dict] = []
    for stmt in node.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            children.append(extract_function(stmt, rel_path, source, parent_class=class_name))
        elif isinstance(stmt, ast.ClassDef):
            children.extend(extract_class(stmt, rel_path, source, prefix=class_name))

    metadata = {
        "bases": [ast.unparse(b) for b in node.bases],
        "decorators": [ast.unparse(d) for d in node.decorator_list],
        "methods": [c["name"] for c in children if c["type"] == "METHOD"],
    }

    class_node = code_node(rel_path, class_name, "CLASS", node.lineno,
                           node.end_lineno or node.lineno, raw, metadata)
    return [class_node, *children]