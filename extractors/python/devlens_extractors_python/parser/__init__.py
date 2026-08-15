"""Parser package — walks the repo and turns .py files into DevLens nodes.

Public API (everything else is internal):
    parse_file(repo_path, rel_path) -> ParsedFile
    walk_python_files(repo_path) -> iterator of relative paths
"""
from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

from ..contract import code_hash, file_node
from .classes import extract_class
from .functions import extract_function
from .walker import is_test_file, walk_python_files

class ParseError(Exception):
    """Raised when a file can't be read or parsed. Non-fatal — the caller
    records it in errors[] and continues with the next file."""

@dataclass
class ParsedFile:
    rel_path: str
    file_node: dict
    nodes: list[dict]          # FUNCTION / CLASS / METHOD nodes (children)
    source: str
    tree: ast.Module

def parse_file(repo_path: str, rel_path: str) -> ParsedFile:
    abs_path = Path(repo_path) / rel_path
    try:
        source = abs_path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise ParseError(f"unreadable file: {exc}") from exc

    try:
        tree = ast.parse(source, filename=rel_path)
    except SyntaxError as exc:
        line = exc.lineno or "?"
        raise ParseError(f"SyntaxError at line {line}: {exc.msg}") from exc

    is_test = is_test_file(rel_path)
    children: list[dict] = []
    test_cases: list[str] = []

    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            children.append(extract_function(stmt, rel_path, source))
            if is_test:
                test_cases.append(stmt.name)
        elif isinstance(stmt, ast.ClassDef):
            children.extend(extract_class(stmt, rel_path, source))
            if is_test:
                test_cases.append(stmt.name)

    end_line = len(source.splitlines()) or 1
    file_node_ = file_node(rel_path, end_line, node_type="TEST" if is_test else "FILE")

    if is_test:
        # Test files are leaf nodes in the graph — children become testCases
        # metadata (mirrors the JS parser, which keeps test helpers out).
        file_node_["metadata"]["testCases"] = test_cases
    else:
        file_node_["metadata"]["nodeCount"] = len(children)
        file_node_["metadata"]["childNodeIds"] = [c["id"] for c in children]
        joined = "\n".join(c.get("rawCode", "") for c in children)
        if joined.strip():
            file_node_["codeHash"] = code_hash(joined)

    return ParsedFile(rel_path=rel_path, file_node=file_node_, nodes=children if not is_test else [],
                      source=source, tree=tree)