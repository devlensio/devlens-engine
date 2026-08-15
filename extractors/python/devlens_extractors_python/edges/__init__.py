"""Edge detectors — import resolution, call resolution, routes, ORM data layer.

Public API (all consume the shared LookupMaps built once by extractor.py):
    resolve_file_imports(parsed, lookup, registry) -> (edges, imported_paths)
    resolve_calls(lookup, registry)                 -> edges
    detect_routes(parsed_files, lookup, fingerprint)-> RouteResult
    detect_models(lookup)                           -> {model name → node id}
    resolve_orm_edges(lookup, models)               -> edges
"""
from .calls import resolve_calls
from .enrich import enrich_metadata
from .imports import resolve_file_imports
from .inheritance import resolve_inheritance
from .orm_edges import detect_models, resolve_orm_edges
from .routes import RouteResult, detect_routes
from .tests import resolve_test_edges

__all__ = [
    "resolve_file_imports",
    "resolve_calls",
    "detect_routes",
    "RouteResult",
    "detect_models",
    "resolve_orm_edges",
    "enrich_metadata",
    "resolve_inheritance",
    "resolve_test_edges",
]
