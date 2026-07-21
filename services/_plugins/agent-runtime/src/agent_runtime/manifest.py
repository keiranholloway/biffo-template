"""Path to this plugin's manifest, shared by plugin.py and the tests.

Mirrors ``services/_plugins/orchestrator/src/orchestrator/manifest.py``: walk up
from this module to find ``biffo.plugin.json``, so it resolves both in the repo
layout (``src/agent_runtime/manifest.py``, manifest at the plugin root) and in
the deployed Lambda (handler ``agent_runtime.main.handler`` unzips the package at
the task root, manifest bundled at ``/var/task/biffo.plugin.json``).
"""

from __future__ import annotations

from pathlib import Path


def _resolve_manifest_path() -> Path:
    here = Path(__file__).resolve()
    for base in here.parents:
        candidate = base / "biffo.plugin.json"
        if candidate.is_file():
            return candidate
    return here.parent.parent / "biffo.plugin.json"


MANIFEST_PATH = _resolve_manifest_path()
