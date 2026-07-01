"""Configure pytest to find the api package from src/."""

import sys
from pathlib import Path

# Add services/api/src to the Python path so `from api.models...` works.
src = Path(__file__).parent.parent / "src"
sys.path.insert(0, str(src))
