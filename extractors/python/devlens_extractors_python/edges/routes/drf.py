"""DRF routers — rest_framework.routers.

router = DefaultRouter(); router.register("users", UserViewSet)
→ list route (GET/POST /prefix/) + detail route (GET/PUT/PATCH/DELETE /prefix/{pk}/)
depending on the viewset kind (ModelViewSet / ReadOnlyModelViewSet / ViewSet).
"""
from __future__ import annotations

import ast

from ...lookup import LookupMaps
from .common import RouteResult, emit_route
from .django_urls import resolve_django_view


def _drf_viewset_kind(viewset_node: dict, lookup: LookupMaps) -> str | None:
    """'model' | 'readonly' | 'plain' | None — how to expand a DRF viewset."""
    rel = viewset_node["filePath"]
    symbols = lookup.symbol_maps.get(rel, {})
    for base in viewset_node["metadata"].get("bases", []):
        root = base.split(".")[-1]          # viewsets.ModelViewSet → ModelViewSet
        alias = symbols.get(root, "")
        is_drf = "rest_framework" in str(alias) or root in (
            "ModelViewSet", "ReadOnlyModelViewSet", "ViewSet", "GenericViewSet")
        if not is_drf:
            continue
        if root == "ModelViewSet":
            return "model"
        if root == "ReadOnlyModelViewSet":
            return "readonly"
        return "plain"
    return None


def _drf_routes_for_viewset(prefix: str, viewset_node: dict, lookup: LookupMaps,
                            result: RouteResult, rel_path: str) -> None:
    """Expand one registered viewset → list + detail routes (HANDLES → CLASS)."""
    kind = _drf_viewset_kind(viewset_node, lookup)
    if kind is None:
        return

    prefix = prefix.strip("/")
    list_path = f"/{prefix}/" if prefix else "/"
    detail_path = f"/{prefix}/{{pk}}/" if prefix else "/{pk}/"

    if kind == "model":
        specs = [("GET", list_path), ("POST", list_path),
                 ("GET", detail_path), ("PUT", detail_path),
                 ("PATCH", detail_path), ("DELETE", detail_path)]
    else:   # readonly + plain → read-only list & detail
        specs = [("GET", list_path), ("GET", detail_path)]

    for method, path in specs:
        emit_route({
            "type": "BACKEND_ROUTE",
            "urlPath": path,
            "filePath": rel_path,
            "httpMethod": method,
            "handlerName": viewset_node["name"],
            "framework": "django",
            "isDynamic": "{pk}" in path,
            "params": ["pk"] if "{pk}" in path else [],
        }, rel_path, viewset_node["id"], result)


def detect_drf_routers(parsed_files: list, lookup: LookupMaps,
                       result: RouteResult) -> None:
    """DefaultRouter().register(prefix, viewset) → expanded CRUD routes."""
    for pf in parsed_files:
        routers: set[str] = set()
        include_prefixes: dict[str, str] = {}

        # pass 1: router = DefaultRouter()  +  path("api/", include(router.urls))
        for stmt in pf.tree.body:
            if isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.Call) \
                    and isinstance(stmt.value.func, ast.Name) \
                    and stmt.value.func.id in ("DefaultRouter", "SimpleRouter"):
                for t in stmt.targets:
                    if isinstance(t, ast.Name):
                        routers.add(t.id)

            if isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.List):
                for elt in stmt.value.elts:
                    if not (isinstance(elt, ast.Call) and len(elt.args) >= 2
                            and isinstance(elt.func, ast.Name)
                            and elt.func.id == "path"
                            and isinstance(elt.args[0], ast.Constant)
                            and isinstance(elt.args[0].value, str)):
                        continue
                    # bind the narrowed constant immediately — Pyright loses
                    # _ConstantValue → str narrowing on elt.args[0].value chains
                    route_prefix: str = elt.args[0].value
                    inc = elt.args[1]
                    if isinstance(inc, ast.Call) and isinstance(inc.func, ast.Name) \
                            and inc.func.id == "include" and inc.args \
                            and isinstance(inc.args[0], ast.Attribute) \
                            and isinstance(inc.args[0].value, ast.Name) \
                            and inc.args[0].attr == "urls":
                        include_prefixes[inc.args[0].value.id] = route_prefix

        if not routers:
            continue

        # pass 2: router.register("users", UserViewSet)
        for stmt in pf.tree.body:
            if not (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call)):
                continue
            call = stmt.value
            if not (isinstance(call.func, ast.Attribute)
                    and call.func.attr == "register"
                    and isinstance(call.func.value, ast.Name)
                    and call.func.value.id in routers):
                continue
            if len(call.args) < 2 or not isinstance(call.args[0], ast.Constant) \
                    or not isinstance(call.args[0].value, str):
                continue

            prefix = call.args[0].value
            viewset_id = resolve_django_view(call.args[1], pf.rel_path, lookup)
            if not viewset_id:
                continue
            viewset_node = lookup.node_by_id.get(viewset_id)
            if not viewset_node or viewset_node["type"] != "CLASS":
                continue

            base = include_prefixes.get(call.func.value.id, "")
            _drf_routes_for_viewset(f"{base}{prefix}", viewset_node, lookup,
                                    result, pf.rel_path)
