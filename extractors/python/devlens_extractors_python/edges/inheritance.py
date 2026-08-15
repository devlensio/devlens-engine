"""Inheritance edges — EXTENDS / IMPLEMENTS (class → base).

Python's interface mechanism is ABC/Protocol inheritance, so:
  - base resolves to a CONCRETE class (or permitted [pip] node) → EXTENDS
  - base resolves to an ABSTRACT class (chain hits ABC/Protocol/ABCMeta)
    → IMPLEMENTS
Bases that resolve to nothing (stdlib, unresolved imports) get no edge —
an edge must always point at a real node (never dangling).

Engine note: CodeEdgeType already defines EXTENDS + IMPLEMENTS ("NEW
LANGUAGES") — Python is the first extractor to emit them.
"""
from __future__ import annotations

from ..lookup import LookupMaps

ABSTRACT_MARKERS = {"ABC", "ABCMeta", "Protocol", "RuntimeProtocol"}


def _is_abstract(node: dict, lookup: LookupMaps, memo: dict,
                 depth: int = 0) -> bool:
    """Class inherits (transitively) from ABC/Protocol/ABCMeta."""
    if depth > 4:
        return False
    node_id = node["id"]
    if node_id in memo:
        return memo[node_id]

    rel = node["filePath"]
    symbols = lookup.symbol_maps.get(rel, {})
    abstract = False

    for base in node["metadata"].get("bases", []):
        parts = base.split(".")
        root = parts[-1]
        if root in ABSTRACT_MARKERS:
            abstract = True
            break
        alias = symbols.get(parts[0], "")
        target = None
        if alias.startswith("file::"):
            target = lookup.nodes_by_file.get(alias[len("file::"):], {}).get(root)
        if not target:
            target = lookup.nodes_by_file.get(rel, {}).get(root)
        if target:
            child = lookup.node_by_id.get(target)
            if child and child["type"] == "CLASS" \
                    and _is_abstract(child, lookup, memo, depth + 1):
                abstract = True
                break

    memo[node_id] = abstract
    return abstract


def resolve_inheritance(lookup: LookupMaps, registry) -> list[dict]:
    """EXTENDS / IMPLEMENTS edges for every CLASS node's bases."""
    edges: list[dict] = []
    abstract_memo: dict[str, bool] = {}

    for node in lookup.node_by_id.values():
        if node["type"] != "CLASS":
            continue
        rel = node["filePath"]
        symbols = lookup.symbol_maps.get(rel, {})

        for base in node["metadata"].get("bases", []):
            parts = base.split(".")
            root = parts[-1]
            alias = symbols.get(parts[0], "")

            # third-party base → [pip] node (only when permitted)
            if alias.startswith("[pip]/"):
                target_id = alias
            # imported module base → local class in that file
            elif alias.startswith("file::"):
                target_id = lookup.nodes_by_file.get(
                    alias[len("file::"):], {}).get(root)
            # same-file base
            else:
                target_id = lookup.nodes_by_file.get(rel, {}).get(root)

            if not target_id or target_id == node["id"]:
                continue

            abstract = False
            target = lookup.node_by_id.get(target_id)
            if target and target["type"] == "CLASS":
                abstract = _is_abstract(target, lookup, abstract_memo)

            edges.append({
                "from": node["id"], "to": target_id,
                "type": "IMPLEMENTS" if abstract else "EXTENDS",
                "metadata": {"baseName": root},
            })

    return edges
