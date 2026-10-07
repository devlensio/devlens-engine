import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


def run_extractor(repo_path: str) -> dict:
    proc = subprocess.run(
        [sys.executable, "-m", "devlens_extractors_python"],
        input=json.dumps({"repoPath": repo_path, "options": {}}),
        capture_output=True,
        text=True,
        cwd=str(REPO / "extractors" / "python"),
        timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def make_repo(files: dict) -> str:
    tmp = tempfile.mkdtemp(prefix="devlens-py-exports-")
    for rel, content in files.items():
        p = Path(tmp) / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    return tmp


def test_direct_export_maps_to_proper_node_id():
    repo = make_repo({
        "mypkg/__init__.py": "from .core import alpha\n",
        "mypkg/core.py": "def alpha():\n    return 1\n",
    })
    result = run_extractor(repo)
    exports = result.get("exports")
    assert exports is not None
    assert exports["exports"]["."]["alpha"] == ["mypkg/core.py::alpha"]
    assert exports["ambiguousNames"] == {}


def test_alias_binding_uses_importer_visible_name():
    repo = make_repo({
        "mypkg/__init__.py": "from .dateutils import formatDate as fmtDate\n",
        "mypkg/dateutils.py": "def formatDate(d):\n    return d\n",
    })
    result = run_extractor(repo)
    exports = result["exports"]
    assert exports["exports"]["."]["fmtDate"] == ["mypkg/dateutils.py::formatDate"]
    assert "formatDate" not in exports["exports"]["."]


def test_name_swap_case_resolves_via_bindings():
    repo = make_repo({
        "mypkg/__init__.py": (
            "from .dateutils import formatDate as fmtDate\n"
            "from .misc import fmtDate as formatDate\n"
        ),
        "mypkg/dateutils.py": "def formatDate(d):\n    return d\n",
        "mypkg/misc.py": "def fmtDate(x):\n    return x\n",
    })
    result = run_extractor(repo)
    exports = result["exports"]
    assert exports["exports"]["."]["fmtDate"] == ["mypkg/dateutils.py::formatDate"]
    assert exports["exports"]["."]["formatDate"] == ["mypkg/misc.py::fmtDate"]
    assert exports["ambiguousNames"] == {}


def test_all_defines_membership_exactly():
    repo = make_repo({
        "mypkg/__init__.py": "from .core import alpha, _secret\n\n__all__ = [\"alpha\"]\n",
        "mypkg/core.py": "def alpha():\n    return 1\n\ndef _secret():\n    return 2\n",
    })
    result = run_extractor(repo)
    exports = result["exports"]
    assert list(exports["exports"]["."].keys()) == ["alpha"]
    assert exports["exports"]["."]["alpha"] == ["mypkg/core.py::alpha"]


def test_star_import_expands_and_excludes_underscore():
    repo = make_repo({
        "mypkg/__init__.py": "from .core import *\n",
        "mypkg/core.py": "def alpha():\n    return 1\n\ndef _private():\n    return 2\n",
    })
    result = run_extractor(repo)
    exports = result["exports"]
    assert exports["exports"]["."]["alpha"] == ["mypkg/core.py::alpha"]
    assert "_private" not in exports["exports"]["."]


def test_nested_init_reexport_chain_is_followed():
    repo = make_repo({
        "mypkg/__init__.py": "from .sub import Thing\n",
        "mypkg/sub/__init__.py": "from .impl import Thing\n",
        "mypkg/sub/impl.py": "class Thing:\n    pass\n",
    })
    result = run_extractor(repo)
    exports = result["exports"]
    assert exports["exports"]["."]["Thing"] == ["mypkg/sub/impl.py::Thing"]


def test_module_reexport_maps_to_file_node():
    repo = make_repo({
        "mypkg/__init__.py": "from . import storage\n",
        "mypkg/storage.py": "def save():\n    return 1\n",
    })
    result = run_extractor(repo)
    exports = result["exports"]
    assert exports["exports"]["."]["storage"] == ["file::mypkg/storage.py"]


def test_duplicate_import_resolves_to_last_binding_python_semantics():
    repo = make_repo({
        "mypkg/__init__.py": "from .a import clash\nfrom .b import clash\n",
        "mypkg/a.py": "def clash():\n    return 1\n",
        "mypkg/b.py": "def clash():\n    return 2\n",
    })
    result = run_extractor(repo)
    exports = result["exports"]
    assert exports["exports"]["."]["clash"] == ["mypkg/b.py::clash"]
    assert exports["ambiguousNames"] == {}


def test_later_star_overrides_earlier_star():
    repo = make_repo({
        "mypkg/__init__.py": "from .a import *\nfrom .b import *\n",
        "mypkg/a.py": "def clash():\n    return 1\n",
        "mypkg/b.py": "def clash():\n    return 2\n",
    })
    result = run_extractor(repo)
    exports = result["exports"]
    assert exports["exports"]["."]["clash"] == ["mypkg/b.py::clash"]


def test_overload_suffixes_appear_in_values():
    repo = make_repo({
        "mypkg/__init__.py": "from .arity import formatValue\n",
        "mypkg/arity.py": (
            "def formatValue(v):\n    return v\n\n"
            "def formatValue(v, n):\n    return v * n\n"
        ),
    })
    result = run_extractor(repo)
    exports = result["exports"]
    ids = exports["exports"]["."]["formatValue"]
    assert len(ids) == 2
    assert "mypkg/arity.py::formatValue#1" in ids
    assert "mypkg/arity.py::formatValue#2" in ids


def test_repos_without_packages_return_no_map():
    repo = make_repo({"standalone.py": "def alpha():\n    return 1\n"})
    result = run_extractor(repo)
    assert "exports" not in result


def test_plain_variables_are_omitted_never_fabricated():
    repo = make_repo({
        "mypkg/__init__.py": "config = {\"a\": 1}\nfrom .core import alpha\n",
        "mypkg/core.py": "def alpha():\n    return 1\n",
    })
    result = run_extractor(repo)
    exports = result["exports"]
    assert "config" not in exports["exports"]["."]
    assert exports["exports"]["."]["alpha"] == ["mypkg/core.py::alpha"]

def test_signature_identical_redefinition_collapses_to_one_node():
    repo = make_repo({
        "mypkg/__init__.py": "from .core import parse\n",
        "mypkg/core.py": "def parse(x):\n    return 1\n\ndef parse(x):\n    return 2\n",
    })
    result = run_extractor(repo)
    exports = result["exports"]
    ids = exports["exports"]["."]["parse"]
    assert ids == ["mypkg/core.py::parse"]
    assert exports["ambiguousNames"] == {}
