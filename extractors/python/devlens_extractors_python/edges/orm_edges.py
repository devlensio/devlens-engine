"""ORM data-layer edges — model detection + READS_FROM/WRITES_TO.

Optimized:
  - ORM call patterns were collected at PARSE time (metadata.ormOps) —
    this module only RESOLVES names via lookup maps. No AST re-walks.
  - Model detection: ONE memoized pass over lookup.node_by_id; base
    chains resolved through symbol maps + local class links (depth-capped).
  - All resolutions are dict lookups (symbol maps, nodes_by_name).

Direction: consumer → store (mirrors stateEdges.ts) — the function/class
that reads or writes points AT the model CLASS node.
"""
from __future__ import annotations

import ast

from ..lookup import LookupMaps, closest_by_path

MAX_BASE_DEPTH = 4


def _flask_sqlalchemy_instances(parsed_files: list, lookup: LookupMaps) -> set:
    """{(rel_path, var)} for `db = SQLAlchemy()` (Flask-SQLAlchemy) — enables
    `class User(db.Model)` base resolution through a local instance."""
    instances: set = set()
    for pf in parsed_files:
        symbols = lookup.symbol_maps.get(pf.rel_path, {})
        if not any("flask_sqlalchemy" in v for v in symbols.values()):
            continue
        for stmt in pf.tree.body:
            if isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.Call) \
                    and isinstance(stmt.value.func, ast.Name) \
                    and stmt.value.func.id == "SQLAlchemy":
                for t in stmt.targets:
                    if isinstance(t, ast.Name):
                        instances.add((pf.rel_path, t.id))
    return instances


def _marker_hit(alias: str, markers: tuple[str, ...]) -> str | None:
    """Marker match against a resolved [pip]/ target.

    'django' uses a PREDICATE (not substring) to avoid false positives like
    django_filters::FilterSet: the target must actually be a django model-ish
    thing (django.db.models, a *.models module, or ::Model/::models member).
    Other markers stay substring-based (single-package ecosystems).
    """
    for marker in markers:
        if marker == "django":
            if any(p in alias for p in
                   ("django.db.models", "::Model", ".models", "::models")):
                return "django"
        elif marker in alias:
            return marker
    return None


def _base_chain_hit(node: dict, lookup: LookupMaps, memo: dict,
                    markers: tuple[str, ...], depth: int = 0,
                    flask_db: frozenset = frozenset()) -> str | None:
    """Walk the base chain; return the first marker matched in [pip]/ aliases.

    markers are substrings tested against resolved third-party targets,
    e.g. ('django', 'sqlalchemy', 'sqlmodel') for models or ('pydantic',) for
    schemas. Handles local chains: class Base(DeclarativeBase) → class User(Base),
    and Flask-SQLAlchemy: class User(db.Model) with db = SQLAlchemy().
    NOTE: each marker set needs its OWN memo dict — a cached miss from one
    scan must not short-circuit a different scan (memo-isolation).
    """
    if depth > MAX_BASE_DEPTH:
        return None
    node_id = node["id"]
    if node_id in memo:
        return memo[node_id]

    rel = node["filePath"]
    symbols = lookup.symbol_maps.get(rel, {})
    result = None

    for base in node["metadata"].get("bases", []):
        parts = base.split(".")
        first, last = parts[0], parts[-1]

        # Flask-SQLAlchemy: db.Model where db = SQLAlchemy() in this file
        if last == "Model" and (rel, first) in flask_db:
            result = "sqlalchemy"
            break

        alias = symbols.get(first, "")

        if alias.startswith("[pip]/"):
            result = _marker_hit(alias, markers)
            if result:
                break
            continue
        # local class (same file or imported file) → recurse the chain
        target = None
        if alias.startswith("file::"):
            target_rel = alias[len("file::"):]
            # db.Model with db = SQLAlchemy() in the imported file
            if last == "Model" and (target_rel, first) in flask_db:
                result = "sqlalchemy"
                break
            target = lookup.nodes_by_file.get(target_rel, {}).get(last)
        if not target:
            target = lookup.nodes_by_file.get(rel, {}).get(last)
        if target:
            child = lookup.node_by_id.get(target)
            if child and child["type"] == "CLASS":
                result = _base_chain_hit(child, lookup, memo, markers,
                                         depth + 1, flask_db)
                if result:
                    break

    memo[node_id] = result
    return result


def detect_models(lookup: LookupMaps,
                  parsed_files: list | None = None) -> dict[str, str]:
    """Mark model CLASS nodes (metadata.isModel/modelType); return name → id map."""
    models: dict[str, str] = {}
    memo: dict[str, str | None] = {}
    flask_db = frozenset(_flask_sqlalchemy_instances(parsed_files or [], lookup))

    for node in lookup.node_by_id.values():
        if node["type"] != "CLASS":
            continue
        kind = _base_chain_hit(node, lookup, memo,
                               ("django", "sqlalchemy", "sqlmodel"),
                               flask_db=flask_db)
        if kind:
            node["metadata"]["isModel"] = True
            node["metadata"]["modelType"] = kind
            models.setdefault(node["name"], node["id"])

    return models


def _resolve_name(lookup: LookupMaps, rel: str, name: str) -> str | None:
    """Name → node id via symbol map (refined), then global closest-by-path."""
    alias = lookup.symbol_maps.get(rel, {}).get(name)
    if alias:
        if alias.startswith("file::"):
            return lookup.nodes_by_file.get(alias[len("file::"):], {}).get(name)
        return alias
    candidates = lookup.nodes_by_name.get(name)
    if candidates:
        return candidates[0][0] if len(candidates) == 1 else closest_by_path(candidates, rel)
    return None


def _match_instance_var(var: str, models: dict[str, str]) -> str | None:
    """user.save() / session.add(user) — var name ↔ model name heuristic.
    Exact → singularized → case-insensitive (user ↔ User, users ↔ User)."""
    for key in (var, var.rstrip("s")):
        if key in models:
            return models[key]
    lower = var.lower()
    for name, node_id in models.items():
        if name.lower() == lower or name.lower() == lower.rstrip("s"):
            return node_id
    return None


def _resolve_orm_target(op: dict, node: dict, lookup: LookupMaps,
                        models: dict[str, str]) -> str | None:
    rel = node["filePath"]

    # bare sqlalchemy statements (select/insert/update/delete) — verify the
    # function name is actually sqlalchemy's, else skip (avoid false positives
    # on generic update()/delete() helpers)
    if op.get("root"):
        alias = lookup.symbol_maps.get(rel, {}).get(op["root"], "")
        if "sqlalchemy" not in alias:
            return None

    if op.get("target"):
        target = models.get(op["target"])            # fast path: name IS a model
        if not target:
            target = _resolve_name(lookup, rel, op["target"])
        if target:
            tnode = lookup.node_by_id.get(target)
            if tnode and tnode["metadata"].get("isModel"):
                return target
        return None

    if op.get("arg"):                                # instance heuristic
        return _match_instance_var(op["arg"], models)

    return None


def resolve_orm_edges(lookup: LookupMaps, models: dict[str, str]) -> list[dict]:
    """metadata.ormOps → READS_FROM/WRITES_TO edges; serializer Meta.model links."""
    edges: list[dict] = []

    for node in lookup.node_by_id.values():
        if node["type"] not in ("FUNCTION", "METHOD", "CLASS"):
            continue
        for op in node["metadata"].get("ormOps", []):
            target = _resolve_orm_target(op, node, lookup, models)
            if not target or target == node["id"]:
                continue
            edges.append({
                "from": node["id"],
                "to": target,
                "type": "READS_FROM" if op["kind"] == "read" else "WRITES_TO",
                "metadata": {"ormType": op["pattern"],
                             "heuristic": bool(op.get("arg"))},
            })

    # DRF serializer: class Meta: model = User → serializer READS_FROM model
    for node in lookup.node_by_id.values():
        if node["type"] != "CLASS":
            continue
        linked = node["metadata"].get("linkedModel")
        if linked and linked in models and models[linked] != node["id"]:
            edges.append({
                "from": node["id"], "to": models[linked],
                "type": "READS_FROM",
                "metadata": {"ormType": "serializer", "callPattern": "meta_model"},
            })

    return edges
