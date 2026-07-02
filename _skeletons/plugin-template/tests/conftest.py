"""Make `example_plugin` and the test-local `fakes` module importable.

This template is a standalone repo (not part of the biffo-template
monorepo's uv workspace — see README's "Standalone repo" note), so
`example_plugin` is installed normally via the project's own
[build-system]/hatchling config when `uv sync` runs. This conftest only
needs to put `tests/` itself on sys.path so `tests/test_example_plugin.py`
can `import fakes` as a plain sibling module (pytest's rootdir insertion
already covers this in most configurations, but the explicit path insert
keeps this working from any cwd, matching the RBAC reference plugin's
`services/rbac/tests/conftest.py` pattern in the biffo-template monorepo).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
