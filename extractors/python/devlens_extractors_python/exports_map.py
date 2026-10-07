"""Exports Map — the flattened public surface of a Python repo.

Mirrors the TypeScript reference (src/parser/exportsMap.ts) and the cross-repo
design (docs/EXPORTS_MAP.md in devlens-engine). Every value is the FINAL,
resolved nodeId as it appears in the nodes array — overload suffixes included.
Consumers of the map never walk import chains.

Python-specific concerns:
  - The "door" is the package root __init__.py; the map key is the name an
    importer sees (`from pkg import name`). Python has no package.json-style
    subpaths, so single-package repos use "." and multi-package repos use
    "./<pkgname>" per top-level package.
  - __all__ (when present, plain list assignment) defines membership exactly;
    otherwise public = non-underscore top-level bindings.
  - `from .mod import name as alias` binds alias → the definition of `name`
    (bindings tracked, never string-matched — name-swap safe).
  - `from .mod import *` expands transitively with cycle guards; underscore
    names stay excluded per Python semantics; explicit bindings always beat
    star-collected ones, and a later star overrides an earlier star.
  - Later bindings override earlier ones (Python semantics: last wins), so
    duplicate imports resolve deterministically; ambiguousNames stays a
    safety net that should remain empty for well-formed Python.
  - Re-export chains through nested __init__.py files are followed
    recursively; modules re-exported as values map to FILE nodes
    (file::pkg/submod.py).
  - Plain variables have no nodes → omitted (never fabricate an id).

Output shape (camelCase, same as the TS extractor):
    {"exports": {subpath: {name: [nodeId, ...]}},
     "ambiguousNames": {subpath: [name, ...]}}
"""
from __future__ import annotations

import ast
from pathlib import Path

_NON_PACKAGE_DIRS = {"tests", "docs", "examples", "scripts", "benchmarks", "node_modules", ".venv", "venv", "build", "dist"}


def build_exports_map(repo_path: str, parsed_files: list, lookup) -> dict | None:
    try:
        packages = _discover_packages(repo_path)
        if not packages:
            return None

        exports: dict[str, dict[str, list[str]]] = {}
        ambiguous: dict[str, list[str]] = {}
        parsed_by_rel = {pf.rel_path: pf for pf in parsed_files}
        single = len(packages) == 1

        for pkg_name, init_rel in packages:
            subpath = "." if single else f"./{pkg_name}"
            per_path, amb = _package_surface(pkg_name, init_rel, parsed_by_rel, lookup)
            if per_path:
                exports[subpath] = per_path
            if amb:
                ambiguous[subpath] = amb

        if not exports:
            return None
        return {"exports": exports, "ambiguousNames": ambiguous}
    except Exception:
        return None


def _discover_packages(repo_path: str) -> list[tuple[str, str]]:
    root = Path(repo_path)
    found: list[tuple[str, str]] = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or entry.name.startswith(".") or entry.name in _NON_PACKAGE_DIRS:
            continue
        if (entry / "__init__.py").exists():
            found.append((entry.name, f"{entry.name}/__init__.py"))
    return found


def _package_surface(pkg_name: str, init_rel: str, parsed_by_rel: dict, lookup):
    init_pf = parsed_by_rel.get(init_rel)
    if init_pf is None:
        return {}, []

    bindings, star_modules = _collect_bindings(init_pf, pkg_name, lookup.module_map)

    star_names: dict[str, list[tuple[str, str, str]]] = {}
    for module in star_modules:
        per_star: dict[str, list[tuple[str, str, str]]] = {}
        _expand_star(module, per_star, lookup, parsed_by_rel, set())
        for name, entries in per_star.items():
            star_names[name] = entries

    for name, entries in star_names.items():
        if name not in bindings:
            bindings[name] = entries

    per_path: dict[str, list[str]] = {}
    ambiguous: list[str] = []

    public = _public_names(init_pf)
    for name in sorted(set(list(bindings.keys()) + public)):
        if name.startswith("_"):
            continue
        targets = bindings.get(name, [])
        resolved_ids: list[str] = []
        definition_files: set[str] = set()
        for kind, target, original in targets:
            ids = _resolve_binding(kind, target, original, parsed_by_rel, lookup, set())
            if ids:
                resolved_ids.extend(ids)
                definition_files.add(_definition_file(ids[0]))
        if not resolved_ids:
            continue
        unique_ids = sorted(set(resolved_ids))
        if len(definition_files) > 1:
            ambiguous.append(name)
        per_path[name] = unique_ids

    return per_path, ambiguous


def _collect_bindings(pf, pkg_name: str, module_map: dict[str, str]):
    """One pass over a module's top-level statements → name → binding targets."""
    bindings: dict[str, list[tuple[str, str, str]]] = {}
    star_modules: list[str] = []

    for stmt in pf.tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bindings[stmt.name] = [("def", pf.rel_path, stmt.name)]
        elif isinstance(stmt, ast.ImportFrom):
            module = _absolute_module(stmt, pf, pkg_name)
            if module is None:
                continue
            for alias in stmt.names:
                if alias.name == "*":
                    if module not in star_modules:
                        star_modules.append(module)
                    continue
                public_name = alias.asname or alias.name
                bindings[public_name] = [("import", module, alias.name)]
        elif isinstance(stmt, ast.Import):
            for alias in stmt.names:
                public_name = alias.asname or alias.name.split(".")[0]
                module = alias.name if alias.asname else alias.name.split(".")[0]
                leaf = module.split(".")[-1]
                bindings[public_name] = [("import", module, leaf)]

    return bindings, star_modules


def _absolute_module(stmt: ast.ImportFrom, pf, pkg_name: str) -> str | None:
    if stmt.level == 0:
        return stmt.module or None
    base_parts = pkg_name.split(".")
    base_parts = base_parts[: max(0, len(base_parts) - (stmt.level - 1))]
    base = ".".join(base_parts)
    if not base:
        return None
    return f"{base}.{stmt.module}" if stmt.module else base


def _expand_star(
    module: str,
    star_names: dict[str, list[tuple[str, str, str]]],
    lookup,
    parsed_by_rel: dict,
    visited: set[str],
):
    if module in visited:
        return
    visited.add(module)

    rel = lookup.module_map.get(module)
    pf = parsed_by_rel.get(rel) if rel else None
    if pf is None:
        return

    bindings, sub_stars = _collect_bindings(pf, module, lookup.module_map)
    for sub in sub_stars:
        _expand_star(sub, star_names, lookup, parsed_by_rel, visited)

    for name, entries in bindings.items():
        if name.startswith("_") or name == "__all__":
            continue
        bucket = star_names.setdefault(name, [])
        for entry in entries:
            if entry not in bucket:
                bucket.append(entry)


def _public_names(pf) -> list[str]:
    for stmt in pf.tree.body:
        if isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                if isinstance(target, ast.Name) and target.id == "__all__":
                    try:
                        return [
                            elt.value
                            for elt in stmt.value.elts
                            if isinstance(elt, ast.Constant) and isinstance(elt.value, str)
                        ]
                    except AttributeError:
                        return []
    return [n for n in _top_level_names(pf) if not n.startswith("_")]


def _top_level_names(pf) -> list[str]:
    names: list[str] = []
    for stmt in pf.tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.append(stmt.name)
        elif isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                if isinstance(target, ast.Name):
                    names.append(target.id)
        elif isinstance(stmt, ast.AnnAssign):
            if isinstance(stmt.target, ast.Name):
                names.append(stmt.target.id)
        elif isinstance(stmt, (ast.ImportFrom, ast.Import)):
            for alias in stmt.names:
                if isinstance(stmt, ast.ImportFrom) and alias.name == "*":
                    continue
                names.append(alias.asname or alias.name.split(".")[0])
    return names


def _resolve_binding(kind, target, original, parsed_by_rel, lookup, visited) -> list[str]:
    if kind == "def":
        ids = lookup.nodes_by_file_all.get(target, {}).get(original, [])
        return list(ids)

    key = (target, original)
    if key in visited:
        return []
    visited.add(key)

    submodule = lookup.module_map.get(f"{target}.{original}")
    if submodule:
        return [f"file::{submodule}"]

    rel = lookup.module_map.get(target)
    if not rel:
        return []

    ids = lookup.nodes_by_file_all.get(rel, {}).get(original, [])
    if ids:
        return list(ids)

    if rel.endswith("__init__.py"):
        pf = parsed_by_rel.get(rel)
        if pf is not None:
            pkg = target
            bindings, _ = _collect_bindings(pf, pkg, lookup.module_map)
            for b_kind, b_target, b_original in bindings.get(original, []):
                deeper = _resolve_binding(b_kind, b_target, b_original, parsed_by_rel, lookup, visited)
                if deeper:
                    return deeper

    return [f"file::{rel}"]


def _definition_file(node_id: str) -> str:
    if node_id.startswith("file::"):
        return node_id[len("file::"):]
    return node_id.split("::")[0]
