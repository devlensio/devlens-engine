"""Route detection — split by framework style:

  decorators.py   FastAPI/Flask decorator routes (+ include_router prefixes)
  django_urls.py  Django urlpatterns (path/re_path/url + include recursion)
  drf.py          DRF routers (DefaultRouter().register → CRUD expansion)
  common.py       shared builders (RouteResult, ROUTE node, HANDLES edge)
"""
from __future__ import annotations

from ...lookup import LookupMaps
from .common import RouteResult
from .decorators import detect_decorator_routes
from .django_urls import detect_django_urlpatterns
from .drf import detect_drf_routers


def detect_routes(parsed_files: list, lookup: LookupMaps, fingerprint) -> RouteResult:
    """Detect FastAPI/Flask decorator routes + Django urlpatterns + DRF routers.
    Self-describing: runs whichever patterns the code actually uses;
    a repo with neither produces an empty RouteResult (never crashes)."""
    result = RouteResult()
    detect_decorator_routes(parsed_files, lookup, fingerprint, result)
    detect_django_urlpatterns(parsed_files, lookup, result)
    detect_drf_routers(parsed_files, lookup, result)
    return result


__all__ = ["detect_routes", "RouteResult"]
