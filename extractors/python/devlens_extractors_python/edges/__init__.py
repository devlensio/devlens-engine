"""Edge detectors — import resolution and call resolution.

Public API:
    resolve_file_imports(parsed, lookup, registry) -> (edges, imported_paths)
    resolve_calls(lookup, registry) -> edges

Both consume the shared LookupMaps (lookup.py) — built once by extractor.py.
Future edge detectors (routes, orm_edges, tests) land in this package too.
"""
from .calls import resolve_calls
from .imports import resolve_file_imports

__all__ = ["resolve_file_imports", "resolve_calls"]
