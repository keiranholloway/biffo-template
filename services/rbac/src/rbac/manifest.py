"""Path to this plugin's manifest file, shared by plugin.py and tests."""

from __future__ import annotations

from pathlib import Path

# src/rbac/manifest.py -> src/rbac -> src -> services/rbac (plugin root, where
# biffo.plugin.json lives alongside pyproject.toml).
MANIFEST_PATH = Path(__file__).resolve().parents[2] / "biffo.plugin.json"
