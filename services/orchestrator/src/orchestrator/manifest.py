"""Path to this plugin's manifest file, shared by plugin.py and tests.

Mirrors the RBAC reference plugin's ``services/rbac/src/rbac/manifest.py`` — a
reliable absolute path to ``biffo.plugin.json`` regardless of the current
working directory the process was started from.
"""

from __future__ import annotations

from pathlib import Path

# src/orchestrator/manifest.py -> src/orchestrator -> src -> repo root
# (plugin root, where biffo.plugin.json lives alongside pyproject.toml).
MANIFEST_PATH = Path(__file__).resolve().parents[2] / "biffo.plugin.json"
