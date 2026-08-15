"""Entry point — invoked as: python3 -m devlens_extractors_python

Reads the ExtractorInput JSON from stdin, runs extraction, writes the
ExtractorResult JSON to stdout. stdout must stay PURE JSON (the Node.js
orchestrator JSON.parses it verbatim) — all logging goes to stderr.
"""
from __future__ import annotations

import json
import sys

from .extractor import extract

def main() -> None:
    raw = sys.stdin.read()

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"devlens extractor: invalid JSON on stdin: {exc}", file=sys.stderr)
        sys.exit(1)

    repo_path = payload.get("repoPath")
    if not repo_path:
        print("devlens extractor: missing 'repoPath' in input", file=sys.stderr)
        sys.exit(1)

    options = payload.get("options") or {}
    result = extract(repo_path, options)
    sys.stdout.write(json.dumps(result) + "\n")

if __name__ == "__main__":
    main()
