"""Fingerprint detection — reads dependency manifests and answers:
what framework, what databases, what raw dependencies?

Manifest priority when several exist: setup.py → pyproject.toml → requirements.txt
(later sources override earlier ones). requirements.txt is usually the
deployed truth, so it wins.
"""

from __future__ import annotations
import ast
import re
import tomllib
from pathlib import Path
from .contract import Fingerprint

#Framework detection order - first match wins
FRAMEWORK_ORDER = ["django", "fastapi", "flask"]

# Dependency package name → DatabaseLibrary value.
# ONLY union-safe values from src/types.ts (postgres, mongodb, mysql, sqlite).
# sqlalchemy/redis intentionally absent — they are ORM/cache layers, not a
# specific DB, and are not in the TS union. They still appear in rawDependencies.
DATABASE_PACKAGES = {
    # postgres
    "psycopg2": "postgres", "psycopg2-binary": "postgres",
    "psycopg": "postgres", "asyncpg": "postgres", "pg8000": "postgres",
    # mongodb
    "pymongo": "mongodb", "motor": "mongodb",
    # mysql
    "pymysql": "mysql", "mysqlclient": "mysql",
    # sqlite
    "aiosqlite": "sqlite",
}

_VERSION_RE = re.compile(r"(\d+\.\d+(?:\.\d+)?(?:[a-z0-9.]*)?)")


def _extract_version(spec: str) -> str:
    """Best-effort version from any specifier: '==0.104.1', '>=1.0,<2.0',
    '^1.0', '~=4.2' → first version-like token, else 'unknown'."""
    match = _VERSION_RE.search(spec)
    return match.group(1) if match else "unknown"

def _parse_pep508(dep: str) -> tuple[str, str]:
    """Parse one PEP 508 dependency string → (name, version).

    Handles: 'fastapi==0.104.1', 'requests[security]>=2.31',
    'pkg @ https://...', 'django~=4.2'.
    """
    name = re.split(r"[<=>~!@\[;]", dep, maxsplit=1)[0].strip().lower()
    return name, _extract_version(dep)

def _parse_requirements(text: str) -> dict[str, str]:
    """requirements.txt: one dep per line. Skip comments, -r/-e directives,
    inline comments, env markers, and extras brackets."""
    deps: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", "-")):
            continue
        line = re.split(r"\s+#", line)[0]   # inline comment (must follow whitespace)
        line = line.split(";")[0].strip()   # env marker: django==4.2 ; python_version >= "3.8"
        if not line:
            continue
        name, version = _parse_pep508(line)
        deps[name] = version
    return deps

def _parse_poetry_deps(data: dict) -> dict[str, str]:
    """Poetry-style deps under [tool.poetry.dependencies].
    Values can be a version string, a dict {version, extras}, or a list of strings."""
    deps: dict[str, str] = {}
    poetry = data.get("tool", {}).get("poetry", {}).get("dependencies", {})
    for name, spec in poetry.items():
        if name == "python":            # poetry requires a python constraint — not a dep
            continue
        if isinstance(spec, str):
            deps[name] = _extract_version(spec)
        elif isinstance(spec, dict) and isinstance(spec.get("version"), str):
            deps[name] = _extract_version(spec["version"])
        elif isinstance(spec, list):
            deps[name] = _extract_version(spec[0]) if spec else "unknown"
    return deps

def _parse_pyproject(path: Path) -> dict[str, str]:
    """pyproject.toml: PEP 621 [project] dependencies + optional-dependencies,
    plus Poetry's [tool.poetry.dependencies]."""
    try:
        with open(path, "rb") as f:     # tomllib requires binary mode
            data = tomllib.load(f)
    except (tomllib.TOMLDecodeError, OSError):
        return {}

    deps: dict[str, str] = {}
    project = data.get("project", {}) or {}

    for dep in project.get("dependencies", []) or []:
        name, version = _parse_pep508(dep)
        deps[name] = version

    for group in (project.get("optional-dependencies", {}) or {}).values():
        for dep in group or []:
            name, version = _parse_pep508(dep)
            deps[name] = version

    deps.update(_parse_poetry_deps(data))
    return deps

def _parse_setup_py(path: Path) -> dict[str, str]:
    """setup.py: parse (never execute!) and read install_requires/extras_require
    string literals out of the AST. Executing repo code during analysis would
    be a security hole."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except (SyntaxError, OSError):
        return {}

    deps: dict[str, str] = {}

    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id == "setup"):
            continue
        for kw in node.keywords:
            if kw.arg == "install_requires" and isinstance(kw.value, ast.List):
                for elt in kw.value.elts:
                    if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                        name, version = _parse_pep508(elt.value)
                        deps[name] = version
            elif kw.arg == "extras_require" and isinstance(kw.value, ast.Dict):
                for value in kw.value.values:
                    if isinstance(value, ast.List):
                        for elt in value.elts:
                            if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                                name, version = _parse_pep508(elt.value)
                                deps[name] = version
    return deps

def _collect_dependencies(repo_path: str) -> dict[str, str]:
    """Merge manifests. Later sources override earlier ones."""
    root = Path(repo_path)
    deps: dict[str, str] = {}

    setup = root / "setup.py"
    if setup.is_file():
        deps.update(_parse_setup_py(setup))

    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        deps.update(_parse_pyproject(pyproject))

    requirements = root / "requirements.txt"
    if requirements.is_file():
        deps.update(_parse_requirements(requirements.read_text(
            encoding="utf-8", errors="replace")))

    return deps

def detect(repo_path: str) -> Fingerprint:
    """Build the fingerprint from dependency manifests. Missing manifests →
    unknown framework, empty deps. Never raises."""
    deps = _collect_dependencies(repo_path)

    fingerprint = Fingerprint()
    fingerprint.rawDependencies = dict(sorted(deps.items()))

    framework = next((fw for fw in FRAMEWORK_ORDER if fw in deps), None)
    # DRF implies Django even if 'django' isn't declared directly
    if framework is None and "djangorestframework" in deps:
        framework = "django"

    if framework:
        fingerprint.framework = framework
        fingerprint.projectType = "backend"

    for pkg, db in DATABASE_PACKAGES.items():
        if pkg in deps and db not in fingerprint.databases:
            fingerprint.databases.append(db)

    return fingerprint
