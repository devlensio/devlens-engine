"""Orchestration — walks the repo, parses files, resolves imports,
detects calls/routes, and assembles the final ExtractorResult.

Pipeline:
  1. walk + parse every .py file → nodes
  2. build shared lookup maps (once) + resolve imports → IMPORTS edges + symbol maps
  3. resolve calls → CALLS edges (lazily creating [pip]/pkg::method nodes)
  4. routes / orm edges / tests edges land here in later steps
  5. collect third-party nodes (AFTER call resolution — lazy nodes)
"""
from __future__ import annotations

from . import edges, fingerprint, parser
from .contract import ExtractorError, Stats
from .lookup import build_lookup_maps
from .third_party import ThirdPartyRegistry


def extract(repo_path: str, options: dict) -> dict:
    fp = fingerprint.detect(repo_path)

    nodes: list[dict] = []
    edges_out: list[dict] = []
    errors: list[dict] = []
    total_files = 0
    skipped = 0

    # 1. walk + parse every file (test files stay leaf nodes)
    parsed_files: list[parser.ParsedFile] = []
    rel_paths: list[str] = []
    for rel in parser.walk_python_files(repo_path):
        total_files += 1
        rel_paths.append(rel)
        try:
            parsed = parser.parse_file(repo_path, rel)
        except parser.ParseError as exc:
            skipped += 1
            errors.append(ExtractorError(file=rel, error=str(exc)).to_dict())
            continue
        parsed_files.append(parsed)
        nodes.append(parsed.file_node)
        nodes.extend(parsed.nodes)

    # 2. shared lookup — built ONCE, consumed by every edge detector
    lookup = build_lookup_maps(parsed_files)
    lookup.module_map = edges.imports.build_module_map(rel_paths)

    registry = ThirdPartyRegistry(fp.rawDependencies)

    for parsed in parsed_files:
        file_edges, imported = edges.resolve_file_imports(parsed, lookup, registry)
        edges_out.extend(file_edges)
        for n in parsed.nodes:
            n["metadata"]["imports"] = imported

    # 3. CALLS edges — same lookup, zero rebuilds
    edges_out.extend(edges.resolve_calls(lookup, registry))

    # 4. third-party nodes — AFTER call resolution (lazy method nodes)
    nodes.extend(registry.nodes)

    stats = Stats(totalFiles=total_files, totalNodes=len(nodes), skippedFiles=skipped)

    return {
        "fingerprint": fp.to_dict(),
        "nodes": nodes,
        "edges": edges_out,
        "routes": [],
        "stats": stats.to_dict(),
        "errors": errors,
    }
