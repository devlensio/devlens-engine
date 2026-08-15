"""Django urlpatterns — path/re_path/url + include() recursion.

urlpatterns = [path("users/<int:id>/", views.get_user), path("api/", include("app.urls"))]
Views resolved through symbol maps + lookup.nodes_by_file (function or CBV class).
"""
from __future__ import annotations

import ast
import re

from ...lookup import LookupMaps, module_name
from .common import RouteResult, emit_route

DJANGO_FUNCS = {"path", "re_path", "url"}                  # urlpatterns callables


def resolve_django_view(view_expr: ast.AST, rel_path: str,
                        lookup: LookupMaps) -> str | None:
    """views.get_user / get_user / UserView.as_view() → handler node id."""
    if isinstance(view_expr, ast.Name):
        name = view_expr.id
        same_file = lookup.nodes_by_file.get(rel_path, {}).get(name)
        if same_file:
            return same_file
        alias = lookup.symbol_maps.get(rel_path, {}).get(name)
        if alias and alias.startswith("file::"):
            return lookup.nodes_by_file.get(alias[len("file::"):], {}).get(name)
        return alias          # node id or None
    if isinstance(view_expr, ast.Attribute):
        root = view_expr.value.id if isinstance(view_expr.value, ast.Name) else None
        if root:
            alias = lookup.symbol_maps.get(rel_path, {}).get(root)
            if alias and alias.startswith("file::"):
                return lookup.nodes_by_file.get(alias[len("file::"):], {}).get(view_expr.attr)
            return alias
        return None
    if isinstance(view_expr, ast.Call):   # UserView.as_view()
        f = view_expr.func
        if isinstance(f, ast.Attribute) and f.attr == "as_view":
            return resolve_django_view(f.value, rel_path, lookup)
    return None


def _view_name(view_expr: ast.AST) -> str | None:
    if isinstance(view_expr, ast.Name):
        return view_expr.id
    if isinstance(view_expr, ast.Attribute):
        return view_expr.attr
    if isinstance(view_expr, ast.Call):
        return _view_name(view_expr.func)
    return None


def _list_elements(value: ast.expr) -> list[ast.expr]:
    """Flatten List and BinOp(Add) chains: `[...] + static(...)` → [...] elements.
    Non-list operands (calls, etc.) contribute nothing."""
    if isinstance(value, ast.List):
        return value.elts
    if isinstance(value, ast.BinOp) and isinstance(value.op, ast.Add):
        return _list_elements(value.left) + _list_elements(value.right)
    return []


def _collect_urlpatterns(pf) -> list[ast.expr]:
    """All urlpatterns elements across every assignment form:
    `urlpatterns = [...]` · `urlpatterns = [...] + other` · `urlpatterns += [...]`."""
    elements: list[ast.expr] = []
    for stmt in pf.tree.body:
        if isinstance(stmt, ast.Assign) and isinstance(stmt.value, (ast.List, ast.BinOp)) \
                and any(isinstance(t, ast.Name) and t.id == "urlpatterns"
                        for t in stmt.targets):
            elements.extend(_list_elements(stmt.value))
        elif isinstance(stmt, ast.AugAssign) and isinstance(stmt.op, ast.Add) \
                and isinstance(stmt.target, ast.Name) and stmt.target.id == "urlpatterns" \
                and isinstance(stmt.value, (ast.List, ast.BinOp)):
            elements.extend(_list_elements(stmt.value))
    return elements


def _include_module(inc_arg: ast.AST, rel_path: str, lookup: LookupMaps) -> str | None:
    """Module name from include() arg: "app.urls" · ("app.urls", "ns") · module_obj."""
    if isinstance(inc_arg, ast.Tuple) and inc_arg.elts:
        inc_arg = inc_arg.elts[0]          # include((module, namespace))
    if isinstance(inc_arg, ast.Constant) and isinstance(inc_arg.value, str):
        return inc_arg.value
    if isinstance(inc_arg, ast.Name):
        alias = lookup.symbol_maps.get(rel_path, {}).get(inc_arg.id)
        if alias and alias.startswith("file::"):
            return module_name(alias[len("file::"):])
    return None


def _expand_urlpatterns(module: str, rel_path: str, url_list: list[ast.expr],
                        url_modules: dict, local_lists: dict,
                        lookup: LookupMaps,
                        result: RouteResult, visited: set, prefix: str,
                        depth: int = 0) -> None:
    # visited is keyed by (module, prefix): the SAME module mounted at two
    # prefixes yields different routes, so each (module, prefix) expands once.
    # depth caps include cycles (a → b → a).
    key = (module, prefix)
    if key in visited or depth > 6:
        return
    visited.add(key)

    for elt in url_list:
        if not isinstance(elt, ast.Call):
            continue
        fname = elt.func.id if isinstance(elt.func, ast.Name) else None
        if fname not in DJANGO_FUNCS:
            continue
        if len(elt.args) < 2 or not isinstance(elt.args[0], ast.Constant) \
                or not isinstance(elt.args[0].value, str):
            continue

        route: str = elt.args[0].value   # bind narrowed constant (Pyright _ConstantValue fix)
        view_expr = elt.args[1]
        full_path = f"{prefix}{route}" if prefix else route

        # include(...) → recurse with the route as prefix
        if isinstance(view_expr, ast.Call) and isinstance(view_expr.func, ast.Name) \
                and view_expr.func.id == "include" and view_expr.args:
            inc_arg = view_expr.args[0]
            if isinstance(inc_arg, ast.Tuple) and inc_arg.elts:
                inc_arg = inc_arg.elts[0]      # include((module, namespace))

            if isinstance(inc_arg, ast.List):
                # inline urlpatterns: include(([path(...), ...], "ns")) — Django's
                # sub-group nesting. id() makes the visited key unique per list.
                _expand_urlpatterns(f"{module}:inline:{id(inc_arg)}", rel_path,
                                    inc_arg.elts, url_modules, local_lists, lookup,
                                    result, visited, full_path, depth + 1)
                continue

            if isinstance(inc_arg, ast.Name):
                # local list variable: login_urlpatterns = [...] → include(login_urlpatterns)
                local = local_lists.get((module, inc_arg.id))
                if local:
                    _expand_urlpatterns(f"{module}:{inc_arg.id}", local[0], local[1],
                                        url_modules, local_lists, lookup, result,
                                        visited, full_path, depth + 1)
                    continue

            target_module = _include_module(inc_arg, rel_path, lookup)
            if target_module and target_module in url_modules:
                t_rel, t_list = url_modules[target_module]
                _expand_urlpatterns(target_module, t_rel, t_list, url_modules,
                                    local_lists, lookup, result, visited,
                                    full_path, depth + 1)
            continue

        params = re.findall(r"<(?:\w+:)?([A-Za-z_]\w*)>", full_path)
        if fname == "re_path":   # named regex groups count as params
            params = re.findall(r"\(\?P<([A-Za-z_]\w*)>", route) or params
        is_dynamic = bool(params) or "<" in full_path or "(" in full_path

        emit_route({
            "type": "BACKEND_ROUTE",
            "urlPath": full_path,
            "filePath": rel_path,
            "httpMethod": "GET",          # Django has no per-route method
            "handlerName": _view_name(view_expr),
            "framework": "django",
            "isDynamic": is_dynamic,
            "params": params,
        }, rel_path, resolve_django_view(view_expr, rel_path, lookup), result)


def detect_django_urlpatterns(parsed_files: list, lookup: LookupMaps,
                              result: RouteResult) -> None:
    url_modules: dict[str, tuple[str, list[ast.expr]]] = {}
    # module-level list variables: login_urlpatterns = [...] → include(login_urlpatterns)
    local_lists: dict[tuple[str, str], tuple[str, list[ast.expr]]] = {}

    for pf in parsed_files:
        mod = module_name(pf.rel_path)
        elements = _collect_urlpatterns(pf)
        if elements:
            url_modules[mod] = (pf.rel_path, elements)
        for stmt in pf.tree.body:
            if isinstance(stmt, ast.Assign) and isinstance(stmt.value, (ast.List, ast.BinOp)):
                for t in stmt.targets:
                    if isinstance(t, ast.Name) and t.id != "urlpatterns":
                        local_lists[(mod, t.id)] = (pf.rel_path, _list_elements(stmt.value))

    # Modules referenced by include(...) are NOT roots — they are mounted
    # somewhere else and only ever reached via include (Django semantics).
    included: set[str] = set()

    def scan_includes(rel_path: str, elements: list[ast.expr]) -> None:
        for elt in elements:
            if not isinstance(elt, ast.Call) or len(elt.args) < 2:
                continue
            view_expr = elt.args[1]
            if not (isinstance(view_expr, ast.Call)
                    and isinstance(view_expr.func, ast.Name)
                    and view_expr.func.id == "include" and view_expr.args):
                continue
            target = _include_module(view_expr.args[0], rel_path, lookup)
            if target:
                included.add(target)

    for _, (rel_path, elements) in url_modules.items():
        scan_includes(rel_path, elements)
    for (mod, name), (rel_path, elements) in local_lists.items():
        scan_includes(rel_path, elements)

    visited: set[tuple[str, str]] = set()
    for module, (rel_path, elements) in url_modules.items():
        if module in included:
            continue   # not a root — only reached via include
        _expand_urlpatterns(module, rel_path, elements, url_modules, local_lists,
                            lookup, result, visited, prefix="")
