import os
import re
from pathlib import Path

# Directories to Ingore
IGNORE_DIRS = {
     ".git", "__pycache__", ".venv", "venv", "env", "node_modules",
    "dist", "build", ".next", "coverage", ".mypy_cache", ".pytest_cache",
    ".tox", ".idea", ".vscode", ".eggs", "site-packages", "migrations",
}

_TEST_FILE_RE = re.compile(r"(?:^|/)(?:test_[^/]+|[^/]+_test)\.py$")


def walk_python_files(repo_path: str):
    """Yield relative paths of every .py file, pruning ignored dirs.

    dirnames[:] = [...] is the in-place prune that makes os.walk skip
    those directories entirely (same role as the JS parser's IGNORE_DIRS)."""
    root = Path(repo_path)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS]
        for fn in sorted(filenames):
            if fn.endswith(".py"):
                rel = Path(dirpath).relative_to(root).as_posix()
                yield f"{rel}/{fn}" if rel != "." else fn

def is_test_file(rel_path: str) -> bool:
    """test_foo.py or foo_test.py, at any depth."""
    return bool(_TEST_FILE_RE.search(rel_path))