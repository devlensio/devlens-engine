"""TESTS edges — test file → the production code it imports.

Mirror of the JS detectTestEdges (src/graph/edges/testEdges.ts):
  - every TEST file node is scanned via its symbol map (import aliases)
  - a local named import pointing at a FILE is refined to the symbol with
    that name inside it (the calls.py refinement)
  - third-party targets and test-importing-test targets are skipped
  - edge: TEST file node → TESTS → production node (metadata.importPath)
"""
from __future__ import annotations

from ..lookup import LookupMaps, module_name


def resolve_test_edges(lookup: LookupMaps) -> list[dict]:
    edges: list[dict] = []
    seen: set[tuple[str, str]] = set()

    for rel, file_node in lookup.file_nodes_by_path.items():
        if file_node["type"] != "TEST":
            continue
        symbols = lookup.symbol_maps.get(rel, {})

        for alias, target in symbols.items():
            # refine file targets to the symbol inside (calls.py refinement)
            if target.startswith("file::"):
                target_rel = target[len("file::"):]
                target_id = lookup.nodes_by_file.get(target_rel, {}).get(alias)
                if not target_id:
                    continue
            elif target.startswith("[pip]/"):
                continue          # third-party — not production code under test
            else:
                target_id = target

            target_node = lookup.node_by_id.get(target_id)
            if not target_node or target_node["type"] in ("TEST", "FILE"):
                continue          # test importing test helpers / plain files
            if target_node["filePath"] == rel:
                continue          # self-import

            key = (file_node["id"], target_id)
            if key in seen:
                continue
            seen.add(key)

            edges.append({
                "from": file_node["id"], "to": target_id, "type": "TESTS",
                "metadata": {"importPath": module_name(target_node["filePath"]),
                             "testFileType": "TEST"},
            })

    return edges
