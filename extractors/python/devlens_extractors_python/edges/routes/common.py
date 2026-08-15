"""Shared route builders — used by decorators.py / django_urls.py / drf.py.

Mirrors routesToCodeNodes in src/pipeline/index.ts: every route emits
  BackendRouteNode dict (routes array), ROUTE code node (graph), and a
  HANDLES edge (ROUTE node → handler node).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from ...lookup import LookupMaps


@dataclass
class RouteResult:
    routes: list[dict] = field(default_factory=list)        # BackendRouteNode[]
    route_nodes: list[dict] = field(default_factory=list)   # ROUTE code nodes
    handles_edges: list[dict] = field(default_factory=list)
    # (filePath, httpMethod, urlPath) — dedupe guard for repeated includes
    _seen: set = field(default_factory=set)


def _route_code_node(route: dict, rel_path: str) -> dict:
    name = f"{route['httpMethod']} {route['urlPath']}"
    return {
        "id": f"{rel_path}::{name}",
        "name": name,
        "type": "ROUTE",
        "filePath": rel_path,
        "startLine": 0,
        "endLine": 0,
        "parentFile": f"file::{rel_path}",
        "metadata": {
            "urlPath": route["urlPath"],
            "httpMethod": route["httpMethod"],
            "isDynamic": route["isDynamic"],
            "params": route.get("params", []),
            "framework": route["framework"],
            "handlerName": route.get("handlerName"),
            "routeKind": "backend",
        },
    }


def emit_route(route: dict, rel_path: str, handler_id: str | None,
               result: RouteResult) -> None:
    key = (rel_path, route["httpMethod"], route["urlPath"])
    if key in result._seen:
        return                      # same route emitted twice (dup include) — skip
    result._seen.add(key)

    node = _route_code_node(route, rel_path)
    result.routes.append(route)
    result.route_nodes.append(node)
    if handler_id:
        result.handles_edges.append({
            "from": node["id"], "to": handler_id, "type": "HANDLES",
            "metadata": {"urlPath": route["urlPath"],
                         "httpMethod": route["httpMethod"],
                         "routeKind": "backend"},
        })


def handler_node_id(rel_path: str, name: str, lookup: LookupMaps) -> str | None:
    """Top-level function → exact id; method → rel::Class.name suffix match."""
    names = lookup.nodes_by_file.get(rel_path, {})
    if name in names:
        return names[name]
    for node_id in lookup.node_by_id:
        if node_id.startswith(f"{rel_path}::") and node_id.endswith(f".{name}"):
            return node_id
    return None


def extract_params(path: str, framework: str) -> list[str]:
    if framework == "fastapi":
        return re.findall(r"\{([A-Za-z_]\w*)(?::[^}]*)?\}", path)
    return re.findall(r"<(?:\w+:)?([A-Za-z_]\w*)>", path)
