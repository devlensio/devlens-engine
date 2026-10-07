"""Overload disambiguation — same-name function-likes in the same file.

Node ids are ``rel/path.py::name``, so two same-name defs in one file (Python
shadowing, dynamic redefinition) produced two nodes with ONE id; downstream
dedupe silently dropped all but the first and every CALLS edge picked one
arbitrarily.

Convention (mirrors the TypeScript reference, src/parser/overloads.ts — keep
in sync, see MULTI_LANGUAGE_EXPANSION.md):
  - unique name in file        → id unchanged
  - distinct arities in group  → ``#arity`` suffix (the def's OWN param count,
                                 never ordinals)
  - same arity, different types → ``#arity#<sig8>`` where sig8 = first 8 hex
                                 chars of sha-256 over the signature string
                                 "(T1,T2)" (rest params prefixed "...",
                                 optional suffixed "?", untyped "unknown")
  - signature-identical defs collapse to one node (prefer the one with a
    body; Python defs always have bodies so the first by line order wins)
Groups are per file; the same name in different files or on different classes
(dotted names) never collides.
"""
from __future__ import annotations

import hashlib

_OVERLOADABLE_TYPES = {"FUNCTION", "METHOD"}


def _param_types(node: dict) -> list[str]:
    parameters = node.get("metadata", {}).get("parameters")
    if not isinstance(parameters, list):
        return []
    types: list[str] = []
    for p in parameters:
        t = p.get("type") if isinstance(p, dict) else None
        t = t if isinstance(t, str) and t else "unknown"
        if p.get("isRest"):
            types.append(f"...{t}")
        elif p.get("isOptional"):
            types.append(f"{t}?")
        else:
            types.append(t)
    return types


def _signature_key(node: dict) -> str:
    return f"({','.join(_param_types(node))})"


def _arity(node: dict) -> int:
    params = node.get("metadata", {}).get("params")
    return len(params) if isinstance(params, list) else 0


def _has_body(node: dict) -> bool:
    return node.get("metadata", {}).get("isOverloadSignature") is not True


def apply_overload_disambiguation(nodes: list[dict], rel_path: str) -> None:
    """Suffix colliding ids in place; mark signature-identical duplicates with
    metadata.isDuplicateOverload for the caller to drop."""
    groups: dict[str, list[dict]] = {}
    for node in nodes:
        if node.get("type") in _OVERLOADABLE_TYPES:
            groups.setdefault(node["name"], []).append(node)

    for name, group in groups.items():
        if len(group) < 2:
            continue
        group.sort(key=lambda n: n["startLine"])

        # Collapse signature-identical defs, preferring the one with a body.
        by_signature: dict[str, dict] = {}
        keys: dict[int, str] = {}
        for node in group:
            key = _signature_key(node)
            keys[id(node)] = key
            existing = by_signature.get(key)
            if existing is None:
                by_signature[key] = node
            elif not _has_body(existing) and _has_body(node):
                by_signature[key] = node
        survivors = sorted(by_signature.values(), key=lambda n: n["startLine"])
        if len(survivors) < len(group):
            kept = {id(n) for n in survivors}
            for node in group:
                if id(node) not in kept:
                    node["metadata"]["isDuplicateOverload"] = True

        # Single survivor after collapse → the name is unique again, no suffix.
        if len(survivors) < 2:
            continue

        # Distinct arities within the group → readable #arity suffix.
        arities = {_arity(n) for n in survivors}
        use_arity_only = len(arities) == len(survivors)

        for node in survivors:
            arity = _arity(node)
            if use_arity_only:
                suffix = f"#{arity}"
            else:
                sig8 = hashlib.sha256(keys[id(node)].encode("utf-8")).hexdigest()[:8]
                suffix = f"#{arity}#{sig8}"
            node["id"] = f"{rel_path}::{name}{suffix}"
