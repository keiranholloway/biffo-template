"""The email address is the identity — guards against the split coming back.

Cognito forces one of two models per pool, immutably: the email as the sign-in
username (`username_attributes`), or a separate username with the email as an
alias (`alias_attributes`). This template uses the former.

That choice is not just cosmetic. Under `alias_attributes`, a federated sign-in
carrying an already-registered address creates a SECOND profile with its own
`sub` and moves the email alias to it, silently leaving the original user unable
to sign in with their own address. As a username attribute the address is unique
pool-wide, so the collision surfaces instead of corrupting an identity.

None of this shows up in a normal test run — the pool is only built at apply
time — so it is asserted here, where a regression is cheap to catch.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from api.schemas.user import CreateUserRequest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_AUTH_MODULE = _REPO_ROOT / "modules/cloud/aws/auth/main.tf"


@pytest.fixture(scope="module")
def auth_tf() -> str:
    return _AUTH_MODULE.read_text()


class TestPoolConfiguration:
    def test_the_email_is_the_sign_in_username(self, auth_tf: str) -> None:
        assert 'username_attributes = ["email"]' in auth_tf

    def test_the_email_is_not_merely_an_alias(self, auth_tf: str) -> None:
        # alias_attributes and username_attributes are mutually exclusive, and
        # switching between them REPLACES the pool and destroys every user in
        # it. Reintroducing this is a data-loss event, not a config tweak.
        #
        # Matches an assignment, not a mention: the comment above the setting
        # names alias_attributes to explain what it replaced, and that prose
        # should not fail the guard.
        assignments = [
            line
            for line in auth_tf.splitlines()
            if line.strip().startswith("alias_attributes") and "=" in line
        ]
        assert assignments == []

    def test_the_invite_keeps_the_placeholders_cognito_demands(self, auth_tf: str) -> None:
        # Verified against the live API: CreateUserPool rejects an invite
        # template whose email_message or sms_message lacks {username} or
        # {####}, so dropping either is a failed deploy. cli's
        # cognito-invite-template-guard enforces this across every module; this
        # asserts it for the one that actually ships.
        invite = auth_tf.split("invite_message_template", 1)[1].split("\n    }", 1)[0]
        for placeholder in ("{username}", "{####}"):
            assert placeholder in invite, f"invite template lost {placeholder}"

    def test_the_invite_does_not_tell_the_reader_to_type_the_username(self, auth_tf: str) -> None:
        # {username} has to be present, but under username_attributes it renders
        # an opaque UUID. The copy must therefore never present it as a
        # credential — the address the message arrived at is the identifier.
        invite = auth_tf.split("invite_message_template", 1)[1].split("\n    }", 1)[0]
        assert "not your email address" not in invite
        assert "email address" in invite


class TestCreateUserRequest:
    def test_there_is_no_username_to_supply(self) -> None:
        # Cognito generates the username itself under username_attributes and
        # ignores anything passed to AdminCreateUser, so accepting one here only
        # invited callers to disagree with the pool. The portal's form is
        # email-only for the same reason.
        assert "username" not in CreateUserRequest.model_fields

    def test_an_email_alone_is_a_complete_request(self) -> None:
        body = CreateUserRequest(email="person@example.com")
        assert body.email == "person@example.com"
        assert body.groups == []

    def test_the_bootstrap_admin_is_created_with_its_email(self, auth_tf: str) -> None:
        # Cognito rejects a non-email username under username_attributes:
        #   InvalidParameterException: Username should be an email
        # This one bites late and hard. The pool is REPLACED first, then the
        # admin user fails to create — so a fresh pool is left with no
        # administrator in it and the apply is only half done. Seeding it from
        # var.admin_username (which is a plain name like "keiran") did exactly
        # that on a live upgrade.
        block = auth_tf.split('resource "aws_cognito_user" "admin"', 1)[1].split("\n}", 1)[0]
        assigned = [
            line.split("=", 1)[1].strip()
            for line in block.splitlines()
            if line.strip().startswith("username") and "=" in line
        ]
        assert assigned == ["var.admin_email"], (
            f"the bootstrap admin's username must be the email address, got {assigned}"
        )
