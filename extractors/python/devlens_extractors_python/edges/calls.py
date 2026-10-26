"""CALLS edge resolution — resolves metadata.callSites names to node ids.

Consumes the shared LookupMaps (lookup.py). Resolution ladder:
  self./cls.        → same-class method (exact dotted name)
  ClassName.method  → same-file dotted lookup
  alias.member      → lazy [pip]/pkg::member node
  module-alias.walk → submodule walk via module_map
  plain name        → own file → import binding → global name

Aliasing (added 2026-10): a name at a call site is not always the name of a
declaration. `from .http import data as httpResponse` and a barrel that only
re-exports (`__init__.py: from .http import data`) mean the caller writes
`httpResponse` while the node is `http.py::data`. Python has no compiler symbol
table, so the chain is walked here by `_resolve_in_module()`: it asks a module
for a name, and when the module only *binds* that name from somewhere else, it
follows the binding — cycle-guarded, depth-capped, memo-free (chains are short
and every hop is an O(1) dict hit).

Overload-aware tiebreak (mirrors src/graph/edges/callEdges.ts): when a lookup
returns multiple same-name candidates, the call site's argument shape picks
the target — arity compatibility first, argTypes agreement second, then the
legacy closest-by-path heuristic. The edge records matchedBy.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..lookup import LookupMaps, closest_by_path, module_name
from ..third_party import ThirdPartyRegistry

# Re-export chains are short in practice; the cap exists so a pathological
# barrel ring cannot loop. Cycles are also caught by `seen`.
MAX_ALIAS_HOPS = 24


@dataclass
class _Scoped:
    """Result of resolving a name against one module's export surface."""
    candidates: list[tuple[str, str]] = field(default_factory=list)  # (node_id, rel)
    chain: list[str] = field(default_factory=list)                    # file::name hops


def _find_in_file(lookup: LookupMaps, rel: str, name: str) -> str | None:
    return lookup.nodes_by_file.get(rel, {}).get(name)


def _find_all_in_file(lookup: LookupMaps, rel: str, name: str) -> list[tuple[str, str]]:
    """Every same-name node id in the file, in declaration order."""
    ids = lookup.nodes_by_file_all.get(rel, {}).get(name, [])
    return [(node_id, rel) for node_id in ids]


def _resolve_in_module(lookup: LookupMaps, rel: str, name: str,
                       seen: set[tuple[str, str]] | None = None) -> _Scoped:
    """Resolve `name` against the EXPORT SURFACE of module `rel`.

    In Python a module's namespace is its declarations PLUS everything it
    imported, so `from pkg import name` works whenever `name` is a module-level
    attribute of `pkg` — including names `pkg` itself imported from elsewhere.
    That is exactly how a package re-exports a symbol (`__init__.py`), and it is
    the phenomenon this resolver models:

      1. declared here                       → the node
      2. `Alias.member` where Alias is bound → resolve Alias, then the member
      3. bound by an import                  → recurse into the binding's target
      4. `from .x import *` sources          → recurse with the same name
    """
    seen = seen if seen is not None else set()
    key = (rel, name)
    if key in seen or len(seen) >= MAX_ALIAS_HOPS:
        return _Scoped()
    seen.add(key)

    # 1. a declaration in this module (dotted names included: "Class.method")
    declared = _find_all_in_file(lookup, rel, name)
    if declared:
        return _Scoped(declared, [f"{rel}::{name}"])

    symbols = lookup.symbol_maps.get(rel, {})
    names = lookup.symbol_names.get(rel, {})

    # 2. member access on a bound name: `US.get` → resolve `US`
    if "." in name:
        root, suffix = name.split(".", 1)
        binding = symbols.get(root)
        if binding and binding.startswith("file::"):
            original = names.get(root, root)
            deeper = _resolve_in_module(lookup, binding[len("file::"):],
                                       f"{original}.{suffix}", seen)
            if deeper.candidates:
                return _Scoped(deeper.candidates, [f"{rel}::{name}"] + deeper.chain)
        return _Scoped()

    # 3. a module-level binding created by an import — the re-export hop
    binding = symbols.get(name)
    if binding:
        original = names.get(name, name)
        if binding.startswith("file::"):
            deeper = _resolve_in_module(lookup, binding[len("file::"):], original, seen)
            if deeper.candidates:
                return _Scoped(deeper.candidates, [f"{rel}::{name}"] + deeper.chain)
            return _Scoped()
        # third-party node id or a direct node id — nothing to walk
        origin_rel = lookup.node_by_id.get(binding, {}).get("filePath", rel)
        return _Scoped([(binding, origin_rel)], [f"{rel}::{name}"])

    # 4. star imports copy public names into this namespace
    for star_rel in lookup.star_imports.get(rel, []):
        deeper = _resolve_in_module(lookup, star_rel, name, seen)
        if deeper.candidates:
            return _Scoped(deeper.candidates, [f"{rel}::{name}"] + deeper.chain)

    return _Scoped()


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


def _pick3(candidates: list[tuple[str, str]], node: dict, call_site: dict | None,
           lookup: LookupMaps, rel: str, chain: list[str]) -> tuple[str | None, str, list[str]]:
    """_pick() plus the alias chain — the shape _resolve() returns."""
    target, matched_by = _pick(candidates, node, call_site, lookup, rel)
    return target, matched_by, chain


def _walk_module(lookup: LookupMaps, alias_target: str, rest: str,
                 root_hint: str | None = None) -> _Scoped:
    """'user.User' with alias → file::models/__init__.py: consume submodule
    segments via module_map, then resolve the symbol in the final module's
    export surface (which may itself re-export it).

    `root_hint` is what the alias was called at the source
    (`from .services import UserService as US` → "UserService"), so a member
    call `US.get()` resolves to the dotted node `UserService.get`."""
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

    tail = ".".join(segments[consumed:])
    if root_hint and consumed == 0 and tail:
        scoped = _resolve_in_module(lookup, current_rel, f"{root_hint}.{tail}")
        if scoped.candidates:
            return scoped
    return _resolve_in_module(lookup, current_rel, tail)


def _resolve(called: str, node: dict, lookup: LookupMaps,
             registry: ThirdPartyRegistry,
             call_site: dict | None) -> tuple[str | None, str, list[str]]:
    rel = node["filePath"]
    symbols = lookup.symbol_maps.get(rel, {})
    symbol_names = lookup.symbol_names.get(rel, {})

    # ── 1. self.x() / cls.x() → method of the enclosing class ──
    if called.startswith(("self.", "cls.")):
        parent_class = node["metadata"].get("parentClass")
        if parent_class:
            return _pick3(_find_all_in_file(lookup, rel,
                                           f"{parent_class}.{called.split('.', 1)[1]}"),
                          node, call_site, lookup, rel, [])
        return None, "name", []

    # ── 2. dotted name ──
    if "." in called:
        root, rest = called.split(".", 1)

        # 2a. ClassName.method defined in the same file
        if root in lookup.nodes_by_file.get(rel, {}):
            return _pick3(_find_all_in_file(lookup, rel, called),
                          node, call_site, lookup, rel, [])

        alias_target = symbols.get(root)
        if not alias_target:
            # 2c. the root itself may be re-exported into THIS module
            scoped = _resolve_in_module(lookup, rel, called)
            if scoped.candidates:
                return _pick3(scoped.candidates, node, call_site, lookup, rel, scoped.chain)
            return None, "name", []

        if alias_target.startswith("[pip]/"):
            # third-party chain: requests.get → lazily create [pip]/requests::get
            pkg = alias_target.split("/", 1)[1]
            if "::" in pkg:
                # chain root is already a named import — current_app.logger.info
                # → [pip]/flask::current_app (the meaningful hop)
                return alias_target, "name", []
            member = registry.method_node(pkg, rest.split(".")[0])
            return (member["id"] if member else None), "name", []

        if alias_target.startswith("file::"):
            # 2b. member access through an import alias — resolve against the
            # target module's export surface (follows re-export chains)
            scoped = _walk_module(lookup, alias_target, rest, symbol_names.get(root))
            if scoped.candidates:
                return _pick3(scoped.candidates, node, call_site, lookup, rel, scoped.chain)
        return None, "name", []

    # ── 3. plain name ──
    # 3a. declared in the caller's own file (exact, no guessing)
    local = _find_all_in_file(lookup, rel, called)
    if local:
        return _pick3(local, node, call_site, lookup, rel, [])

    # 3b. imported into this file → the target module's export surface
    alias_target = symbols.get(called)
    if alias_target:
        if alias_target.startswith("file::"):
            scoped = _resolve_in_module(lookup, alias_target[len("file::"):], called)
            if scoped.candidates:
                return _pick3(scoped.candidates, node, call_site, lookup, rel, scoped.chain)
            return None, "name", []
        # direct node id ("path.py::Symbol" or a third-party id, e.g. decorators)
        return alias_target, "name", []

    # 3c. global name — overload ladder on collision
    candidates = lookup.nodes_by_name.get(called)
    if candidates:
        return _pick3(candidates, node, call_site, lookup, rel, [])

    # 3d. copied into this namespace by `from .x import *`
    scoped = _resolve_in_module(lookup, rel, called)
    if scoped.candidates:
        return _pick3(scoped.candidates, node, call_site, lookup, rel, scoped.chain)

    return None, "name", []


def resolve_calls(lookup: LookupMaps, registry: ThirdPartyRegistry) -> list[dict]:
    """Resolve every FUNCTION/METHOD node's call sites → CALLS edges.
    Also writes metadata.resolvedCalls back onto nodes (JS callEdges.ts mirror).
    Each (name, arity, argTypes) call site resolves separately — a caller that
    invokes two overload siblings of one name gets two edges."""
    edges: list[dict] = []

    for node in lookup.node_by_id.values():
        # FILE nodes are callers for module-scope execution (calls run at
        # import time, attached by parser/__init__.py). TEST leaves excluded.
        if node["type"] not in ("FUNCTION", "METHOD", "FILE"):
            continue
        metadata = node["metadata"]
        sites = metadata.get("callSites") or [{"name": c} for c in metadata.get("calls", [])]
        resolved: list[dict] = []
        for site in sites:
            called = site["name"]
            target, matched_by, chain = _resolve(called, node, lookup, registry, site)
            if target and target != node["id"]:
                edge_meta = {"calledName": called, "matchedBy": matched_by}
                origin = lookup.node_by_id.get(target, {})
                origin_name = origin.get("name")
                if origin_name and origin_name != called:
                    # what the graph edge actually points at (alias → origin)
                    edge_meta["resolvedName"] = origin_name
                    edge_meta["aliased"] = True
                if chain and len(chain) > 1:
                    edge_meta["aliasChain"] = chain
                if node["type"] == "FILE":
                    edge_meta["scope"] = "module"
                edges.append({"from": node["id"], "to": target, "type": "CALLS",
                              "metadata": edge_meta})
                resolved.append({"name": called, "nodeId": target})
        metadata["resolvedCalls"] = resolved

    return edges
