"""
contract Types - the JSON shape Devlens Engine expects.

Every key here is camel  case to match the typescript interface in the devlens-engine. This file is the single
source of truth for the output shape; other modules never spell keys by hand.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
from typing import Any

def code_hash(raw_code: str) -> str:
    """Return a SHA256 hash of the raw code string."""
    return hashlib.sha256(raw_code.encode("utf-8")).hexdigest()[:16]  # first 16 chars of the hash

@dataclass
class Fingerprint:
    language: str = "python"
    projectType: str = "unknown"          # "backend" once a framework is detected
    framework: str = "unknown"            # "fastapi" | "flask" | "django" | "unknown"
    router: str = "none"
    stateManagement: list = field(default_factory=list)  # always [] for Python
    dataFetching: list = field(default_factory=list)     # always [] for Python
    databases: list = field(default_factory=list)
    rawDependencies: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "language": self.language,
            "projectType": self.projectType,
            "framework": self.framework,
            "router": self.router,
            "stateManagement": self.stateManagement,
            "dataFetching": self.dataFetching,
            "databases": self.databases,
            "rawDependencies": self.rawDependencies,
        }

@dataclass
class Stats:
    totalFiles: int = 0
    totalNodes: int = 0
    skippedFiles: int = 0

    def to_dict(self) -> dict:
        return {
            "totalFiles": self.totalFiles,
            "totalNodes": self.totalNodes,
            "skippedFiles": self.skippedFiles,
        }

@dataclass
class ExtractorError:
    file: str
    error: str

    def to_dict(self) -> dict:
        return {"file": self.file, "error": self.error}

def file_node(rel_path: str, end_line: int, node_type: str = "FILE",
              language: str = "python") -> dict:
    """FILE node — id format: file::rel/path.py (matches src/parser/index.ts)."""
    return {
        "id": f"file::{rel_path}",
        "name": rel_path.split("/")[-1],
        "type": node_type,                      # FILE | TEST
        "filePath": rel_path,
        "startLine": 1,
        "endLine": end_line,
        "parentFile": f"file::{rel_path}",      # file nodes parent themselves
        "metadata": {
            "nodeCount": 0,
            "childNodeIds": [],
            "language": language,
        },
    }

def code_node(rel_path: str, name: str, node_type: str, start_line: int, end_line: int,
              raw_code: str, metadata: dict, language: str = "python") -> dict:
    """Function/Class/Method node. ID format: rel/path.py::name."""
    return {
        "id": f"{rel_path}::{name}",
        "name": name,
        "type": node_type,
        "filePath": rel_path,
        "startLine": start_line,
        "endLine": end_line,
        "rawCode": raw_code,
        "codeHash": code_hash(raw_code),
        "parentFile": f"file::{rel_path}",
        "metadata": {"language": language, **metadata},
    }
