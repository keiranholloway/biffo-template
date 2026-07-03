"""Configure pytest to find the pr_signer package from src/."""

import sys
from pathlib import Path

# Add services/pr-signer/src to the Python path so `from pr_signer...` works,
# including under a root `uv run pytest` collection.
src = Path(__file__).parent.parent / "src"
sys.path.insert(0, str(src))
