"""Import resolution — the sys.path simulation.

Resolves every import to a local file (IMPORTS edge) or a third-party
package node ([pip]/...). Also writes the per-file symbol map
(local name → target node id) into lookup.symbol_maps, which CALLS
resolution and route detection consume.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass

from ..lookup import LookupMaps
from ..parser import ParsedFile
from ..third_party import STDLIB_MODULES, ThirdPartyRegistry


@dataclass
class ImportItem:
    module: str | None     # dotted module as written ("models.user", None for bare relative)
    name: str | None       # imported name for from-imports (None for `import x`)
    alias: str             # local binding ("User", "as_name", or top package for `import a.b`)
    level: int             # 0 = absolute, 1 = ".", 2 = ".."
    is_star: bool


def extract_imports(tree: ast.Module) -> list[ImportItem]:
    items: list[ImportItem] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                items.append(ImportItem(
                    module=alias.name, name=None,
                    alias=alias.asname or alias.name.split(".")[0],
                    level=0, is_star=False))
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                items.append(ImportItem(
                    module=node.module, name=None if alias.name == "*" else alias.name,
                    alias=alias.asname or alias.name,
                    level=node.level, is_star=alias.name == "*"))
    return items


def build_module_map(rel_paths: list[str]) -> dict[str, str]:
    """dotted module name → relative file path.

    'models/user.py' → 'models.user' · 'models/__init__.py' → 'models'
    src/ layout: 'src/models/user.py' also registers as 'models.user'.
    First registration wins (deterministic)."""
    module_map: dict[str, str] = {}

    def register(rel: str) -> None:
        parts = rel.split("/")
        if parts[-1] == "__init__.py":
            module = ".".join(parts[:-1])
        else:
            module = ".".join(parts[:-1] + [parts[-1][:-3]])
        module_map.setdefault(module, rel)

    for rel in rel_paths:
        register(rel)
        if rel.startswith("src/"):
            register(rel[4:])

    return module_map


def _current_package(rel_path: str) -> str:
    """Dotted package of a file: 'models/sub/views.py' → 'models.sub'."""
    return ".".join(rel_path.split("/")[:-1])


def resolve_file_imports(parsed: ParsedFile, lookup: LookupMaps,
                         registry: ThirdPartyRegistry) -> tuple[list[dict], list[str]]:
    """Resolve one file's imports.

    Returns (edges, imported_local_paths). Writes into lookup.symbol_maps
    (local alias → target node id), used by CALLS + route resolution.
    """
    rel = parsed.rel_path
    file_id = parsed.file_node["id"]
    file_symbols: dict[str, str] = {}
    edges: list[dict] = []
    imported_paths: list[str] = []
    module_map = lookup.module_map
    symbol_map = lookup.symbol_maps

    for item in extract_imports(parsed.tree):
        # ── 1. Expand relative imports to an absolute module name ──
        if item.level == 0:
            module = item.module or ""
        else:
            base_parts = _current_package(rel).split(".")
            base_parts = base_parts[: max(0, len(base_parts) - (item.level - 1))]
            base = ".".join(base_parts)
            module = f"{base}.{item.module}" if item.module else base

        # `from . import x` — x may be a submodule (base.x) or a symbol in base
        if item.name and item.module is None:
            sub = module_map.get(f"{module}.{item.name}")
            if sub:
                file_symbols[item.alias] = f"file::{sub}"
                imported_paths.append(sub)
                edges.append({"from": file_id, "to": f"file::{sub}", "type": "IMPORTS",
                              "metadata": {"importPath": module, "importedName": item.name}})
                continue

        # ── 2. Try to resolve inside the repo ──
        target_rel = module_map.get(module)
        if target_rel:
            target_file_id = f"file::{target_rel}"
            imported_paths.append(target_rel)

            if item.is_star:
                # Can't know which names — edge to the module file, tag ambiguous
                edges.append({"from": file_id, "to": target_file_id, "type": "IMPORTS",
                              "metadata": {"importPath": module, "isStarImport": True}})
                continue

            if item.name:
                # from X import Y — Y may be a submodule (X/Y.py) or a symbol in X
                sub = module_map.get(f"{module}.{item.name}")
                if sub:
                    target_file_id = f"file::{sub}"
                    imported_paths.append(sub)

            file_symbols[item.alias] = target_file_id
            edges.append({"from": file_id, "to": target_file_id, "type": "IMPORTS",
                          "metadata": {"importPath": module,
                                       "importedName": item.name}})
            continue

        # ── 3. Not local → stdlib (skip) or third-party (node) ──
        if item.level > 0:
            continue  # relative import that failed locally — skip silently

        pkg = module.split(".")[0]
        if not module or pkg in STDLIB_MODULES:
            continue  # stdlib / builtin — noise, no edge, no node

        if item.name and not item.is_star:
            target = registry.method_node(pkg, item.name)
        else:
            target = registry.package_node(pkg)
        if target is None:
            continue  # third-party not permitted (options.includedThirdPartyLibs)

        file_symbols[item.alias] = target["id"]
        edges.append({"from": file_id, "to": target["id"], "type": "IMPORTS",
                      "metadata": {"importPath": pkg, "isThirdParty": True,
                                   "importedName": item.name}})

    symbol_map[rel] = file_symbols
    return edges, sorted(set(imported_paths))
