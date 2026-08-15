"""Class extraction — CLASS node + METHOD children + model/schema metadata.

Collects at parse time (resolved later by edges/orm_edges.py):
  fields[]       — Django field / SQLAlchemy Column assignments
  linkedModel    — DRF serializer `class Meta: model = User`
  ormOps         — ORM calls in class-level statements (e.g. `queryset = User.objects.all()`)
"""
from __future__ import annotations

import ast

from ..contract import code_node
from .functions import NESTED_SCOPES, _match_orm_call, _walk_scope, extract_function

FIELD_TYPE_NAMES = {
    # Django ORM fields
    "CharField", "TextField", "IntegerField", "BigIntegerField",
    "PositiveIntegerField", "PositiveBigIntegerField", "SmallIntegerField",
    "FloatField", "DecimalField", "BooleanField", "DateField", "DateTimeField",
    "TimeField", "DurationField", "EmailField", "URLField", "UUIDField",
    "JSONField", "SlugField", "BinaryField", "FileField", "ImageField",
    "FilePathField", "AutoField", "BigAutoField", "ForeignKey",
    "OneToOneField", "ManyToManyField", "GenericForeignKey", "ArrayField",
    # SQLAlchemy
    "Column", "relationship", "mapped_column",
}


def _extract_fields(node: ast.ClassDef) -> list[str]:
    """Field names from class-body assignments: `name = CharField(...)`."""
    fields: list[str] = []
    for stmt in node.body:
        if not isinstance(stmt, ast.Assign) or not isinstance(stmt.value, ast.Call):
            continue
        f = stmt.value.func
        fname = f.id if isinstance(f, ast.Name) else (
            f.attr if isinstance(f, ast.Attribute) else None)
        if fname not in FIELD_TYPE_NAMES:
            continue
        for t in stmt.targets:
            if isinstance(t, ast.Name):
                fields.append(t.id)
    return fields


def _extract_linked_model(node: ast.ClassDef) -> str | None:
    """DRF serializer: inner `class Meta: model = User` → 'User'."""
    for stmt in node.body:
        if isinstance(stmt, ast.ClassDef) and stmt.name == "Meta":
            for inner in stmt.body:
                if isinstance(inner, ast.Assign) and isinstance(inner.value, ast.Name):
                    for t in inner.targets:
                        if isinstance(t, ast.Name) and t.id == "model":
                            return inner.value.id
    return None


def _extract_class_orm_ops(node: ast.ClassDef) -> list[dict]:
    """ORM calls in class-level statements (queryset = Model.objects.all())."""
    stmts = [s for s in node.body
             if not isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
    ops: list[dict] = []

    def visit(n: ast.AST) -> None:
        if isinstance(n, ast.Call):
            op = _match_orm_call(n)
            if op:
                ops.append(op)

    _walk_scope(stmts, visit)
    return ops


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

    fields = _extract_fields(node)
    if fields:
        metadata["fields"] = fields

    linked = _extract_linked_model(node)
    if linked:
        metadata["linkedModel"] = linked

    class_ops = _extract_class_orm_ops(node)
    if class_ops:
        metadata["ormOps"] = class_ops

    class_node = code_node(rel_path, class_name, "CLASS", node.lineno,
                           node.end_lineno or node.lineno, raw, metadata)
    return [class_node, *children]
