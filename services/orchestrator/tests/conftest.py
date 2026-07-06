"""Configure pytest to find the orchestrator package from src/ (same pattern as
services/rbac/tests/conftest.py — this workspace member has no [build-system],
so it's a uv "virtual" package, not installed into the shared venv)."""

import sys
from pathlib import Path

src = Path(__file__).parent.parent / "src"
sys.path.insert(0, str(src))
