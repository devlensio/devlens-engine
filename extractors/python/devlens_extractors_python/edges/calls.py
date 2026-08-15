"""CALLS edge resolution — resolves metadata.calls names to node ids.

Consumes the shared LookupMaps (lookup.py). Resolution ladder:
  self./cls.        → same-class method (exact dotted name)
  ClassName.method  → same-file dotted lookup
  alias.member      → lazy [pip]/pkg::member node
  module-alias.walk → submodule walk via module_map
  plain name        → global nodes_by_name → import alias refinement
Unknown/builtin names resolve to nothing (no edge) — metadata.calls keeps
them for LLM context.
"""
from __future__ import annotations

from ..lookup import LookupMaps, closest_by_path, module_name
from ..third_party import ThirdPartyRegistry


def _find_in_file(lookup: LookupMaps, rel: str, name: str) -> str | None:
    return lookup.nodes_by_file.get(rel, {}).get(name)


def _walk_module(lookup: LookupMaps, alias_target: str, rest: str) -> str | None:
    """'user.User' with alias → file::models/__init__.py: consume submodule
    segments via module_map, then look up the symbol in the final file."""
    current_rel = alias_target[len("file::"):]
    current_module = module_name(current_rel)
    segments = rest.split(".")
    consumed = 0

    while consumed < len(segments):
        candidate = f"{current_module}.{segments[consumed]}"
        nxt = lookup.module_map.get(candidate)
        if not nxt:
            break
        current_rel, current_module = nxt, candidate
        consumed += 1

    return _find_in_file(lookup, current_rel, ".".join(segments[consumed:]))


def _resolve(called: str, node: dict, lookup: LookupMaps,
             registry: ThirdPartyRegistry) -> str | None:
    rel = node["filePath"]
    symbols = lookup.symbol_maps.get(rel, {})

    # ── 1. self.x() / cls.x() → method of the enclosing class ──
    if called.startswith(("self.", "cls.")):
        parent_class = node["metadata"].get("parentClass")
        if parent_class:
            return _find_in_file(lookup, rel,
                                 f"{parent_class}.{called.split('.', 1)[1]}")
        return None

    # ── 2. dotted name ──
    if "." in called:
        root, rest = called.split(".", 1)

        # 2a. ClassName.method defined in the same file
        if root in lookup.nodes_by_file.get(rel, {}):
            return _find_in_file(lookup, rel, called)

        # 2b. member access through an import alias
        alias_target = symbols.get(root)
        if not alias_target:
            return None
        if alias_target.startswith("[pip]/"):
            # third-party chain: requests.get → lazily create [pip]/requests::get
            pkg = alias_target.split("/", 1)[1]
            if "::" in pkg:
                # chain root is already a named import — current_app.logger.info
                # → [pip]/flask::current_app (the meaningful hop)
                return alias_target
            member = registry.method_node(pkg, rest.split(".")[0])
            return member["id"] if member else None
        if alias_target.startswith("file::"):
            return _walk_module(lookup, alias_target, rest)
        return None

    # ── 3. plain name — global lookup, closest-by-path on collision ──
    candidates = lookup.nodes_by_name.get(called)
    if candidates:
        if len(candidates) == 1:
            return candidates[0][0]
        return closest_by_path(candidates, rel)

    # ── 4. import alias — refine file targets to the actual symbol ──
    alias_target = symbols.get(called)
    if alias_target:
        if alias_target.startswith("file::"):
            return _find_in_file(lookup, alias_target[len("file::"):], called)
        return alias_target   # "[pip]/..." or "path.py::Symbol"
    return None


def resolve_calls(lookup: LookupMaps, registry: ThirdPartyRegistry) -> list[dict]:
    """Resolve every FUNCTION/METHOD node's calls → CALLS edges.
    Also writes metadata.resolvedCalls back onto nodes (JS callEdges.ts mirror)."""
    edges: list[dict] = []

    for node in lookup.node_by_id.values():
        if node["type"] not in ("FUNCTION", "METHOD"):
            continue
        resolved: list[dict] = []
        for called in node["metadata"].get("calls", []):
            target = _resolve(called, node, lookup, registry)
            if target and target != node["id"]:
                edges.append({"from": node["id"], "to": target, "type": "CALLS",
                              "metadata": {"calledName": called}})
                resolved.append({"name": called, "nodeId": target})
        node["metadata"]["resolvedCalls"] = resolved

    return edges
