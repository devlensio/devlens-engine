"""Orchestration — walks the repo, parses files, resolves imports,
detects routes, and assembles the final ExtractorResult.

Step 1 stub: returns a valid-but-empty result so we can verify the
stdin → stdout contract loop before building the real pipeline.
"""
from __future__ import annotations

from .contract import ExtractorError, Fingerprint, Stats

def extract(repo_path: str, options: dict) -> dict:
    fingerprint = Fingerprint()
    stats = Stats()
    return {
        "fingerprint": fingerprint.to_dict(),
        "nodes": [],
        "edges": [],
        "routes": [],
        "stats": stats.to_dict(),
        "errors": [],
    }