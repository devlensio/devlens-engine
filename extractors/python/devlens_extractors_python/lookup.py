"""Shared lookup maps — the analysis index.

Mirrors the JS buildLookupMaps() (src/graph/buildLookup.ts): built ONCE per
extraction and passed to every edge detector (calls, routes, orm, tests) so
nobody rebuilds indexes. All lookups are O(1) map hits.

Field owners:
  nodes_by_name / nodes_by_file / node_by_id / file_nodes_by_path  — build_lookup_maps()
  module_map                                                       — extractor (imports.build_module_map)
  symbol_maps                                                      — edges.imports.resolve_file_imports
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class LookupMaps:
    # name → [(node_id, rel_path)] — global, closest-by-path on collision
    nodes_by_name: dict[str, list[tuple[str, str]]] = field(default_factory=dict)
    # rel_path → {node name → node_id} — same-file / refinement lookups
    nodes_by_file: dict[str, dict[str, str]] = field(default_factory=dict)
    # node_id → node dict — direct access to any parsed node
    node_by_id: dict[str, dict] = field(default_factory=dict)
    # rel_path → FILE/TEST node dict
    file_nodes_by_path: dict[str, dict] = field(default_factory=dict)
    # rel_path → {local alias → target id} — import precision (edges.imports writes)
    symbol_maps: dict[str, dict[str, str]] = field(default_factory=dict)
    # dotted module name → rel path (imports.build_module_map builds)
    module_map: dict[str, str] = field(default_factory=dict)


def module_name(rel: str) -> str:
    """'models/user.py' → 'models.user' · 'models/__init__.py' → 'models'."""
    parts = rel.split("/")
    if parts[-1] == "__init__.py":
        return ".".join(parts[:-1])
    return ".".join(parts[:-1] + [parts[-1][:-3]])


def build_lookup_maps(parsed_files: list) -> LookupMaps:
    """One pass over all parsed files → shared indexes."""
    lookup = LookupMaps()

    for pf in parsed_files:
        lookup.file_nodes_by_path[pf.rel_path] = pf.file_node
        lookup.node_by_id[pf.file_node["id"]] = pf.file_node

        names: dict[str, str] = {}
        for n in pf.nodes:
            names.setdefault(n["name"], n["id"])
            lookup.node_by_id[n["id"]] = n
            lookup.nodes_by_name.setdefault(n["name"], []).append((n["id"], pf.rel_path))
        lookup.nodes_by_file[pf.rel_path] = names

    return lookup


def closest_by_path(candidates: list[tuple[str, str]], rel: str) -> str:
    """Pick the candidate whose file shares the most leading path segments
    with the caller (same heuristic as the JS closestByPath)."""
    caller_parts = rel.split("/")
    best_id, best_score = candidates[0][0], -1
    for node_id, cand_rel in candidates:
        score = 0
        for a, b in zip(caller_parts, cand_rel.split("/")):
            if a != b:
                break
            score += 1
        if score > best_score:
            best_id, best_score = node_id, score
    return best_id
