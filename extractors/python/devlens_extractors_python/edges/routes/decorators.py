"""FastAPI / Flask decorator routes.

@app.get("/users/{id}") · @app.route("/users/<int:id>", methods=[...])
Also handles app.include_router(router, prefix="/api") prefix joining.
"""
from __future__ import annotations

import ast

from ...lookup import LookupMaps
from .common import RouteResult, emit_route, extract_params, handler_node_id

HTTP_METHODS = {"get", "post", "put", "delete", "patch", "head", "options"}
ROUTE_ATTRS = HTTP_METHODS | {"route", "add_api_route"}   # decorator attr names


def _include_router_prefixes(tree: ast.Module) -> dict[str, str]:
    """Module-level app.include_router(x, prefix='/api') → {x: '/api'}."""
    prefixes: dict[str, str] = {}
    for stmt in tree.body:
        if not (isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call)):
            continue
        call = stmt.value
        if not (isinstance(call.func, ast.Attribute)
                and call.func.attr == "include_router"):
            continue
        if not call.args or not isinstance(call.args[0], ast.Name):
            continue
        prefix = ""
        for kw in call.keywords:
            if kw.arg == "prefix" and isinstance(kw.value, ast.Constant) \
                    and isinstance(kw.value.value, str):
                prefix = kw.value.value
        if not prefix and len(call.args) > 1 and isinstance(call.args[1], ast.Constant) \
                and isinstance(call.args[1].value, str):
            prefix = call.args[1].value
        prefixes[call.args[0].id] = prefix
    return prefixes


def _decorator_route(dec: ast.AST, prefixes: dict[str, str],
                     fingerprint) -> dict | None:
    """One decorator → route dict (framework, path, methods, params) or None."""
    if not isinstance(dec, ast.Call) or not isinstance(dec.func, ast.Attribute):
        return None
    method = dec.func.attr.lower()
    if method not in ROUTE_ATTRS:
        return None
    app_var = dec.func.value.id if isinstance(dec.func.value, ast.Name) else None
    if not app_var:
        return None
    if not dec.args or not isinstance(dec.args[0], ast.Constant) \
            or not isinstance(dec.args[0].value, str):
        return None

    path: str = dec.args[0].value   # bind narrowed constant (Pyright _ConstantValue fix)
    # framework: fingerprint when known, else infer from syntax
    if fingerprint.framework in ("fastapi", "flask"):
        framework = fingerprint.framework
    elif method == "route" or "<" in path:
        framework = "flask"
    else:
        framework = "fastapi"

    prefix = prefixes.get(app_var, "")
    full_path = f"{prefix}{path}" if prefix else path

    params = extract_params(full_path, framework)
    is_dynamic = bool(params) or "{" in full_path or "<" in full_path

    # Flask: @app.route(path, methods=[...]) → several methods; default GET
    if method == "route":
        http_methods: list[str] = ["GET"]
        for kw in dec.keywords:
            if kw.arg == "methods" and isinstance(kw.value, ast.List):
                http_methods = [elt.value.upper() for elt in kw.value.elts
                                if isinstance(elt, ast.Constant)
                                and isinstance(elt.value, str)]
                break
    else:
        http_methods = [method.upper()]

    return {"framework": framework, "path": full_path, "methods": http_methods,
            "params": params, "is_dynamic": is_dynamic}


def _router_construction_prefixes(tree: ast.Module) -> dict[str, str]:
    """router = APIRouter(prefix='/items') → {'router': '/items'}.

    FastAPI's documented way to scope a router — the prefix applies to every
    decorator on that router, composed with any include_router(prefix=...) later.
    """
    prefixes: dict[str, str] = {}
    for stmt in tree.body:
        if not (isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.Call)
                and isinstance(stmt.value.func, ast.Name)
                and stmt.value.func.id == "APIRouter"):
            continue
        for kw in stmt.value.keywords:
            if kw.arg == "prefix" and isinstance(kw.value, ast.Constant) \
                    and isinstance(kw.value.value, str):
                for t in stmt.targets:
                    if isinstance(t, ast.Name):
                        prefixes[t.id] = kw.value.value
    return prefixes


def _blueprint_prefix_maps(parsed_files: list, lookup: LookupMaps) -> dict[str, dict[str, str]]:
    """Flask blueprints — prefix composition ACROSS files → {rel_path: {var: prefix}}.

    Flask scatters the pieces: `auth = Blueprint('auth', __name__)` in
    app/auth/__init__.py, `@auth.route(...)` in app/auth/views.py (auth imported
    there), and `app.register_blueprint(auth_blueprint, url_prefix='/auth')`
    inside create_app() in app/__init__.py. Registration vars are linked to
    blueprint NAMES via the single-blueprint-per-module heuristic; decorator
    vars (local or imported) get the composed prefix.
    """
    construction: dict[tuple[str, str], tuple[str, str]] = {}   # (rel, var) → (name, prefix)
    registration: dict[str, dict[str, str]] = {}               # rel → {var: prefix}

    for pf in parsed_files:
        # ast.walk: registrations often live inside create_app()/factory functions
        for stmt in ast.walk(pf.tree):
            if isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.Call) \
                    and isinstance(stmt.value.func, ast.Name) \
                    and stmt.value.func.id == "Blueprint" and stmt.value.args \
                    and isinstance(stmt.value.args[0], ast.Constant) \
                    and isinstance(stmt.value.args[0].value, str):
                name = stmt.value.args[0].value
                cprefix = ""
                for kw in stmt.value.keywords:
                    if kw.arg == "url_prefix" and isinstance(kw.value, ast.Constant) \
                            and isinstance(kw.value.value, str):
                        cprefix = kw.value.value
                for t in stmt.targets:
                    if isinstance(t, ast.Name):
                        construction[(pf.rel_path, t.id)] = (name, cprefix)
            elif isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call) \
                    and isinstance(stmt.value.func, ast.Attribute) \
                    and stmt.value.func.attr == "register_blueprint" \
                    and stmt.value.args and isinstance(stmt.value.args[0], ast.Name):
                rprefix = ""
                for kw in stmt.value.keywords:
                    if kw.arg == "url_prefix" and isinstance(kw.value, ast.Constant) \
                            and isinstance(kw.value.value, str):
                        rprefix = kw.value.value
                registration.setdefault(pf.rel_path, {})[stmt.value.args[0].id] = rprefix

    def constructions_in(rel: str) -> list[tuple[str, str, str]]:
        return [(v, n, p) for (r, v), (n, p) in construction.items() if r == rel]

    # link registration vars → blueprint names (single-construction heuristic)
    by_name: dict[str, str] = {}
    for rel, vars_map in registration.items():
        symbols = lookup.symbol_maps.get(rel, {})
        for var, rprefix in vars_map.items():
            alias = symbols.get(var, "")
            target_rel = alias[len("file::"):] if alias.startswith("file::") else rel
            candidates = constructions_in(target_rel)
            if len(candidates) == 1:
                _, name, cprefix = candidates[0]
                by_name[name] = cprefix + rprefix

    # per-file var → prefix: local constructions AND imported blueprint refs
    per_file: dict[str, dict[str, str]] = {}
    for (rel, var), (name, cprefix) in construction.items():
        per_file.setdefault(rel, {})[var] = by_name.get(name, cprefix)
    for pf in parsed_files:
        symbols = lookup.symbol_maps.get(pf.rel_path, {})
        for var, alias in symbols.items():
            if not alias.startswith("file::"):
                continue
            candidates = constructions_in(alias[len("file::"):])
            if len(candidates) == 1:
                _, name, cprefix = candidates[0]
                per_file.setdefault(pf.rel_path, {})[var] = by_name.get(name, cprefix)
    return per_file


def detect_decorator_routes(parsed_files: list, lookup: LookupMaps,
                            fingerprint, result: RouteResult) -> None:
    blueprint_maps = _blueprint_prefix_maps(parsed_files, lookup)

    for pf in parsed_files:
        # effective prefix = construction + include_router/register_blueprint
        router_prefixes = _router_construction_prefixes(pf.tree)
        include_prefixes = _include_router_prefixes(pf.tree)
        prefixes = {
            var: router_prefixes.get(var, "") + include_prefixes.get(var, "")
            for var in set(router_prefixes) | set(include_prefixes)
        }
        prefixes.update(blueprint_maps.get(pf.rel_path, {}))

        for node in ast.walk(pf.tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            handler_id = handler_node_id(pf.rel_path, node.name, lookup)
            for dec in node.decorator_list:
                route = _decorator_route(dec, prefixes, fingerprint)
                if not route:
                    continue
                for http_method in route["methods"]:
                    emit_route({
                        "type": "BACKEND_ROUTE",
                        "urlPath": route["path"],
                        "filePath": pf.rel_path,
                        "httpMethod": http_method,
                        "handlerName": node.name,
                        "framework": route["framework"],
                        "isDynamic": route["is_dynamic"],
                        "params": route["params"],
                    }, pf.rel_path, handler_id, result)
