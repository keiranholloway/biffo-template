"""Configure pytest to find the api package from src/."""

import sys
from pathlib import Path

# Add services/api/src to the Python path so `from api.models...` works.
src = Path(__file__).parent.parent / "src"
sys.path.insert(0, str(src))


import pytest  # noqa: E402


class _AllVerifiedSes:
    """Default SESv2 stand-in: every identity is verified (no AWS in unit tests)."""

    def get_email_identity(self, EmailIdentity: str) -> dict:  # noqa: N803
        return {"VerifiedForSendingStatus": True}


@pytest.fixture(autouse=True)
def _fake_ses_identity_lookup(monkeypatch):
    """Keep the save-time sender check (api.sender_check) off real AWS."""
    from api import sender_check

    monkeypatch.setattr(sender_check, "_get_client", lambda: _AllVerifiedSes())
