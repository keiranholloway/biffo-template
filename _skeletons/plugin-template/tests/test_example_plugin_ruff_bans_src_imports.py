"""The TID251 `src` ban rejects `src.<pkg>.<mod>` imports and accepts `<pkg>.<mod>`."""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _tid251(tmp_path: Path, source: str) -> list[dict]:
    f = tmp_path / "probe.py"
    f.write_text(source)
    out = subprocess.run(  # noqa: S603
        [
            sys.executable,
            "-m",
            "ruff",
            "check",
            "--config",
            str(ROOT / "pyproject.toml"),
            "--no-cache",
            "--select",
            "TID251",
            "--output-format",
            "json",
            str(f),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return json.loads(out.stdout)


def test_submodule_src_import_is_rejected(tmp_path):
    assert _tid251(tmp_path, "from src.pkg.mod import x\n")


def test_plain_and_dotted_src_imports_are_rejected(tmp_path):
    assert _tid251(tmp_path, "import src\n")
    assert _tid251(tmp_path, "import src.pkg.mod\n")


def test_package_name_import_is_accepted(tmp_path):
    assert _tid251(tmp_path, "from pkg.mod import x\n") == []
