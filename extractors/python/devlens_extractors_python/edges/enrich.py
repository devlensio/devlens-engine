"""Metadata enrichment — pydantic isSchema + celery isTask (Step 9).

Resolves parse-time facts (metadata.bases, metadata.decorators) via symbol
maps. No AST re-walks. IMPORTANT: each marker set needs its OWN memo dict —
a cached 'miss' from the model scan must not short-circuit the schema scan.
"""
from __future__ import annotations

from ..lookup import LookupMaps
from .orm_edges import _base_chain_hit


def _is_celery_task(decorators: list[str], lookup: LookupMaps, rel: str) -> bool:
    """@shared_task (celery's own name) · @app.task / @celery_app.task
    (Celery instance pattern) · bare @task (requires celery import proof)."""
    symbols = lookup.symbol_maps.get(rel, {})
    for dec in decorators:
        root = dec.split("(")[0].strip()   # strip args: "app.task()" → "app.task"
        parts = root.split(".")
        if not parts:
            continue
        if parts[-1] == "shared_task":
            return True                    # celery-specific decorator name
        if parts[-1] == "task" and len(parts) >= 2:
            return True                    # @app.task — Celery instance pattern
        if parts[-1] == "task" and "celery" in symbols.get("task", ""):
            return True                    # bare @task, imported from celery
    return False


def enrich_metadata(lookup: LookupMaps) -> None:
    """Mark pydantic schemas (CLASS nodes) and celery tasks (FUNCTION/METHOD).

    Pure metadata mutation — no new nodes or edges."""
    memo: dict[str, str | None] = {}       # own memo — marker-set isolation

    for node in lookup.node_by_id.values():
        if node["type"] == "CLASS":
            if _base_chain_hit(node, lookup, memo, ("pydantic", "sqlmodel")):
                node["metadata"]["isSchema"] = True
        if node["type"] in ("FUNCTION", "METHOD") \
                and _is_celery_task(node["metadata"].get("decorators", []),
                                    lookup, node["filePath"]):
            node["metadata"]["isTask"] = True
