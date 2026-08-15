"""Third-party node creation — [pip]/pkg and [pip]/pkg::name nodes.

Mirrors the JS side's [npm]/... convention (src/graph/thirdPartyLibs.ts +
importEdges.ts): one package node per import, per-name method nodes for
named imports, all deduped in a single registry.
"""
from __future__ import annotations

import sys

# Exact stdlib module set from the running interpreter (Python 3.10+).
STDLIB_MODULES = frozenset(sys.stdlib_module_names)

# Runtime libraries — real architectural decisions (mirrors RUNTIME_INCLUSION_SET)
RUNTIME_PACKAGES = {
    "fastapi", "flask", "django", "starlette", "uvicorn", "gunicorn",
    "sqlalchemy", "pydantic", "alembic", "psycopg2", "psycopg", "asyncpg",
    "pymongo", "motor", "redis", "celery", "requests", "httpx", "aiohttp",
    "numpy", "pandas", "scipy", "scikit-learn", "tensorflow", "torch",
    "pyjwt", "passlib", "bcrypt", "cryptography", "boto3", "stripe",
    "openai", "anthropic", "langchain", "sentry-sdk", "loguru",
    "beautifulsoup4", "scrapy", "pillow", "opencv-python", "matplotlib",
}

# Dev tooling — low signal (mirrors the JS devtool category)
DEVTOOL_PACKAGES = {
    "pytest", "black", "flake8", "mypy", "ruff", "isort", "coverage",
    "tox", "nox", "pre-commit", "sphinx", "mkdocs", "hypothesis",
    "responses", "vcrpy", "faker", "factory-boy", "freezegun",
}

class ThirdPartyRegistry:
    """Creates and caches [pip]/... nodes. One registry per extraction —
    the same package imported in 20 files yields ONE node."""

    def __init__(self, raw_dependencies: dict[str, str]):
        self._nodes: dict[str, dict] = {}
        self.raw_dependencies = raw_dependencies

    def _base_metadata(self, pkg: str) -> dict:
        version = self.raw_dependencies.get(pkg, "unknown")
        if pkg in RUNTIME_PACKAGES:
            category = "runtime"
        elif pkg in DEVTOOL_PACKAGES:
            category = "devtool"
        else:
            category = "unknown"
        return {"isThirdParty": True, "packageVersion": version, "category": category}

    def package_node(self, pkg: str) -> dict:
        node_id = f"[pip]/{pkg}"
        if node_id not in self._nodes:
            self._nodes[node_id] = {
                "id": node_id,
                "name": pkg,
                "type": "THIRD_PARTY",
                "filePath": node_id,
                "startLine": 0,
                "endLine": 0,
                "metadata": self._base_metadata(pkg),
            }
        return self._nodes[node_id]

    def method_node(self, pkg: str, name: str) -> dict:
        """Named import member: from flask import Flask → [pip]/flask::Flask."""
        node_id = f"[pip]/{pkg}::{name}"
        if node_id not in self._nodes:
            pkg_node = self.package_node(pkg)
            self._nodes[node_id] = {
                "id": node_id,
                "name": f"{pkg}.{name}",
                "type": "THIRD_PARTY",
                "filePath": f"[pip]/{pkg}",
                "startLine": 0,
                "endLine": 0,
                "metadata": {
                    **pkg_node["metadata"],
                    "parentPackageId": pkg_node["id"],
                    "methodName": name,
                },
            }
        return self._nodes[node_id]

    @property
    def nodes(self) -> list[dict]:
        return list(self._nodes.values())