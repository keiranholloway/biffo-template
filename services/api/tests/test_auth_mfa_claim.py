"""`AuthenticatedUser.mfa_authenticated`, derived from the token's `amr` claim.

Consumed by gates that require step-up authentication rather than group
membership alone. Fail-closed throughout: anything unrecognised means no MFA, so
a malformed or absent claim can never let a caller through such a gate.
"""

import api.middleware.auth as auth_module
import pytest
from api.middleware.auth import _amr_indicates_mfa, identity_from_token
from fastapi.security import HTTPAuthorizationCredentials


class TestAmrParsing:
    @pytest.mark.parametrize(
        "amr",
        [
            ["pwd", "mfa"],
            ["software_token_mfa"],
            ["sms_mfa"],
            ["totp"],
            ("pwd", "otp"),
            "pwd mfa",
            ["PWD", "MFA"],  # case-insensitive
        ],
    )
    def test_recognises_mfa(self, amr):
        assert _amr_indicates_mfa(amr) is True

    @pytest.mark.parametrize(
        "amr",
        [
            ["pwd"],
            [],
            "",
            "pwd",
            None,
            42,
            {"mfa": True},  # a dict is not a factor list
            object(),
        ],
    )
    def test_fails_closed(self, amr):
        assert _amr_indicates_mfa(amr) is False


class TestOnAuthenticatedUser:
    @pytest.fixture
    def _claims(self, monkeypatch):
        def _stub(claims):
            monkeypatch.setattr(auth_module, "_verify_token", lambda _t: claims)

        return _stub

    def _call(self):
        return identity_from_token(HTTPAuthorizationCredentials(scheme="Bearer", credentials="t"))

    def test_set_when_token_shows_mfa(self, _claims):
        _claims({"sub": "s1", "amr": ["pwd", "mfa"]})
        assert self._call().mfa_authenticated is True

    def test_unset_without_the_claim(self, _claims):
        _claims({"sub": "s1"})
        assert self._call().mfa_authenticated is False

    def test_defaults_false_on_bare_construction(self):
        """Non-auth construction sites must not read as MFA-authenticated."""
        assert (
            auth_module.AuthenticatedUser(
                sub="s", email="", username="", tenant_id="default"
            ).mfa_authenticated
            is False
        )
