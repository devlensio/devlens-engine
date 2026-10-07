"""CALLS edge resolution — resolves metadata.callSites names to node ids.

Consumes the shared LookupMaps (lookup.py). Resolution ladder:
  self./cls.        → same-class method (exact dotted name)
  ClassName.method  → same-file dotted lookup
  alias.member      → lazy [pip]/pkg::member node
  module-alias.walk → submodule walk via module_map
  plain name        → global nodes_by_name → import alias refinement
Unknown/builtin names resolve to nothing (no edge) — metadata.calls keeps
them for LLM context.

Overload-aware tiebreak (mirrors src/graph/edges/callEdges.ts): when a lookup
returns multiple same-name candidates, the call site's argument shape picks
the target — arity compatibility first, argTypes agreement second, then the
legacy closest-by-path heuristic. The edge records matchedBy.
"""
from __future__ import annotations

from ..lookup import LookupMaps, closest_by_path, module_name
from ..third_party import ThirdPartyRegistry


def _find_in_file(lookup: LookupMaps, rel: str, name: str) -> str | None:
    return lookup.nodes_by_file.get(rel, {}).get(name)


def _find_all_in_file(lookup: LookupMaps, rel: str, name: str) -> list[tuple[str, str]]:
    """Every same-name node id in the file, in declaration order."""
    ids = lookup.nodes_by_file_all.get(rel, {}).get(name, [])
    return [(node_id, rel) for node_id in ids]


def _bound_params(node: dict) -> tuple[list, list]:
    """(effective_params, effective_parameters) for arity/type matching —
    bound methods hide self/cls from the call site's argument count."""
    metadata = node.get("metadata", {})
    params = metadata.get("params") or []
    parameters = metadata.get("parameters") or []
    if node.get("type") == "METHOD" and params and params[0] in ("self", "cls"):
        params = params[1:]
        parameters = [p for p in parameters if p.get("name") not in ("self", "cls")]
    return params, parameters


def _arity_matches(node: dict, arg_count: int) -> bool:
    """A candidate accepts the call when argCount covers every required
    (non-optional, non-rest) param and does not exceed the declared count
    unless a rest param (*args/**kwargs) absorbs the extras. Nodes without
    parameter shape metadata are permissive."""
    params, parameters = _bound_params(node)
    if not params and not parameters:
        return True
    total = len(parameters) if parameters else len(params)
    required = sum(1 for p in parameters if not p.get("isOptional") and not p.get("isRest")) \
        if parameters else total
    has_rest = any(p.get("isRest") for p in parameters) if parameters else False
    return arg_count >= required and (has_rest or arg_count <= total)


def _type_agrees(arg_type: str, param_type) -> bool:
    if not arg_type or arg_type == "unknown" or not param_type:
        return False
    return param_type == arg_type or arg_type in param_type


def _type_score(node: dict, arg_types: list[str]) -> int:
    _, parameters = _bound_params(node)
    score = 0
    for i, t in enumerate(arg_types):
        if i >= len(parameters):
            break
        if _type_agrees(t, parameters[i].get("type")):
            score += 1
    return score


def _pick(candidates: list[tuple[str, str]], node: dict, call_site: dict | None,
          lookup: LookupMaps, rel: str) -> tuple[str | None, str]:
    """Ladder: single hit → name · arity filter → type tiebreak → path.
    Returns (target_id, matchedBy)."""
    if not candidates:
        return None, "name"
    if len(candidates) == 1:
        return candidates[0][0], "name"

    usable_shape = (call_site is not None
                    and not call_site.get("hasSpread")
                    and isinstance(call_site.get("argCount"), int))
    if not usable_shape:
        return closest_by_path(candidates, rel), "name"

    arg_count = call_site["argCount"]
    pool = [c for c in candidates
            if _arity_matches(lookup.node_by_id.get(c[0], {}), arg_count)]
    if not pool:
        pool = candidates                      # nothing accepts this arity — keep all
    if len(pool) == 1:
        return pool[0][0], "arity"

    arg_types = call_site.get("argTypes") or []
    if any(t and t != "unknown" for t in arg_types):
        best = pool[0]
        best_score = _type_score(lookup.node_by_id.get(best[0], {}), arg_types)
        tie_at_best = 1
        for cand in pool[1:]:
            score = _type_score(lookup.node_by_id.get(cand[0], {}), arg_types)
            if score > best_score:
                best, best_score, tie_at_best = cand, score, 1
            elif score == best_score:
                tie_at_best += 1
        if best_score > 0 and tie_at_best == 1:
            return best[0], "signature"

    return closest_by_path(pool, rel), "name"


def _walk_module(lookup: LookupMaps, alias_target: str, rest: str) -> list[tuple[str, str]]:
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

    return _find_all_in_file(lookup, current_rel, ".".join(segments[consumed:]))


def _resolve(called: str, node: dict, lookup: LookupMaps,
             registry: ThirdPartyRegistry, call_site: dict | None) -> tuple[str | None, str]:
    rel = node["filePath"]
    symbols = lookup.symbol_maps.get(rel, {})

    # ── 1. self.x() / cls.x() → method of the enclosing class ──
    if called.startswith(("self.", "cls.")):
        parent_class = node["metadata"].get("parentClass")
        if parent_class:
            return _pick(_find_all_in_file(lookup, rel, f"{parent_class}.{called.split('.', 1)[1]}"),
                         node, call_site, lookup, rel)
        return None, "name"

    # ── 2. dotted name ──
    if "." in called:
        root, rest = called.split(".", 1)

        # 2a. ClassName.method defined in the same file
        if root in lookup.nodes_by_file.get(rel, {}):
            return _pick(_find_all_in_file(lookup, rel, called),
                         node, call_site, lookup, rel)

        # 2b. member access through an import alias
        alias_target = symbols.get(root)
        if not alias_target:
            return None, "name"
        if alias_target.startswith("[pip]/"):
            # third-party chain: requests.get → lazily create [pip]/requests::get
            pkg = alias_target.split("/", 1)[1]
            if "::" in pkg:
                # chain root is already a named import — current_app.logger.info
                # → [pip]/flask::current_app (the meaningful hop)
                return alias_target, "name"
            member = registry.method_node(pkg, rest.split(".")[0])
            return (member["id"] if member else None), "name"
        if alias_target.startswith("file::"):
            return _pick(_walk_module(lookup, alias_target, rest),
                         node, call_site, lookup, rel)
        return None, "name"

    # ── 3. plain name — global lookup, overload ladder on collision ──
    candidates = lookup.nodes_by_name.get(called)
    if candidates:
        return _pick(candidates, node, call_site, lookup, rel)

    # ── 4. import alias — refine file targets to the actual symbol ──
    alias_target = symbols.get(called)
    if alias_target:
        if alias_target.startswith("file::"):
            return _pick(_find_all_in_file(lookup, alias_target[len("file::"):], called),
                         node, call_site, lookup, rel)
        return alias_target, "name"   # "[pip]/..." or "path.py::Symbol"
    return None, "name"


def resolve_calls(lookup: LookupMaps, registry: ThirdPartyRegistry) -> list[dict]:
    """Resolve every FUNCTION/METHOD node's call sites → CALLS edges.
    Also writes metadata.resolvedCalls back onto nodes (JS callEdges.ts mirror).
    Each (name, arity, argTypes) call site resolves separately — a caller that
    invokes two overload siblings of one name gets two edges."""
    edges: list[dict] = []

    for node in lookup.node_by_id.values():
        if node["type"] not in ("FUNCTION", "METHOD"):
            continue
        metadata = node["metadata"]
        sites = metadata.get("callSites") or [{"name": c} for c in metadata.get("calls", [])]
        resolved: list[dict] = []
        for site in sites:
            called = site["name"]
            target, matched_by = _resolve(called, node, lookup, registry, site)
            if target and target != node["id"]:
                edges.append({"from": node["id"], "to": target, "type": "CALLS",
                              "metadata": {"calledName": called, "matchedBy": matched_by}})
                resolved.append({"name": called, "nodeId": target})
        metadata["resolvedCalls"] = resolved

    return edges
