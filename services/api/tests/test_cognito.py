"""Unit tests for the CognitoAdmin adapter, exercised against a moto fake pool."""

from unittest.mock import Mock

import boto3
import pytest
from api.cognito import (
    REDACTED,
    CognitoAdmin,
    CognitoAdminError,
    generate_temporary_password,
    redact_secret,
)
from botocore.exceptions import ClientError
from moto import mock_aws

REGION = "us-east-1"


@pytest.fixture
def pool():
    """A fake Cognito user pool with the baseline groups, plus a CognitoAdmin
    bound to it. Yields (admin, raw_client, pool_id)."""
    with mock_aws():
        client = boto3.client("cognito-idp", region_name=REGION)
        pool_id = client.create_user_pool(PoolName="test")["UserPool"]["Id"]
        for group in ("admin", "editor", "viewer"):
            client.create_group(UserPoolId=pool_id, GroupName=group)
        admin = CognitoAdmin(client=client, user_pool_id=pool_id, region=REGION)
        yield admin, client, pool_id


def test_create_user_returns_normalized_user_with_sub(pool):
    admin, _client, _pool_id = pool
    user = admin.create_user(
        email="alice@example.com",
        given_name="Alice",
        family_name="Anderson",
        suppress_invite_email=True,
    )

    assert user["username"] == "alice@example.com"
    assert user["email"] == "alice@example.com"
    assert user["sub"]  # a generated uuid
    assert user["enabled"] is True


def test_create_user_assigns_initial_groups(pool):
    admin, _client, _pool_id = pool
    admin.create_user(
        email="bob@example.com",
        given_name="Bob",
        family_name="Baker",
        groups=["editor"],
        suppress_invite_email=True,
    )

    assert admin.list_groups_for_user("bob@example.com") == ["editor"]


def test_get_user_roundtrip(pool):
    admin, _client, _pool_id = pool
    admin.create_user(
        email="carol@example.com",
        given_name="Carol",
        family_name="Chen",
        suppress_invite_email=True,
    )

    fetched = admin.get_user("carol@example.com")
    assert fetched["email"] == "carol@example.com"


def test_list_users_includes_created_users(pool):
    admin, _client, _pool_id = pool
    admin.create_user(
        email="dave@example.com", given_name="Dave", family_name="Davis", suppress_invite_email=True
    )
    admin.create_user(
        email="erin@example.com", given_name="Erin", family_name="Evans", suppress_invite_email=True
    )

    result = admin.list_users()
    emails = {u["email"] for u in result["users"]}
    assert {"dave@example.com", "erin@example.com"} <= emails


def test_disable_then_enable_user_toggles_enabled(pool):
    admin, _client, _pool_id = pool
    admin.create_user(
        email="frank@example.com",
        given_name="Frank",
        family_name="Foster",
        suppress_invite_email=True,
    )

    admin.disable_user("frank@example.com")
    assert admin.get_user("frank@example.com")["enabled"] is False

    admin.enable_user("frank@example.com")
    assert admin.get_user("frank@example.com")["enabled"] is True


def test_delete_user_removes_it(pool):
    admin, _client, _pool_id = pool
    admin.create_user(
        email="grace@example.com",
        given_name="Grace",
        family_name="Green",
        suppress_invite_email=True,
    )

    admin.delete_user("grace@example.com")

    with pytest.raises(CognitoAdminError) as excinfo:
        admin.get_user("grace@example.com")
    assert excinfo.value.code == "UserNotFoundException"


def test_add_and_remove_group(pool):
    admin, _client, _pool_id = pool
    admin.create_user(
        email="heidi@example.com",
        given_name="Heidi",
        family_name="Hill",
        suppress_invite_email=True,
    )

    admin.add_to_group(username="heidi@example.com", group="admin")
    assert "admin" in admin.list_groups_for_user("heidi@example.com")

    admin.remove_from_group(username="heidi@example.com", group="admin")
    assert "admin" not in admin.list_groups_for_user("heidi@example.com")


def test_list_groups_returns_pool_groups(pool):
    admin, _client, _pool_id = pool
    assert set(admin.list_groups()) == {"admin", "editor", "viewer"}


def test_get_missing_user_raises_typed_error(pool):
    admin, _client, _pool_id = pool
    with pytest.raises(CognitoAdminError) as excinfo:
        admin.get_user("nobody@example.com")
    assert excinfo.value.code == "UserNotFoundException"


# --- caller-supplied TemporaryPassword (#950) ------------------------------


def _password_reaches_cognito(client, pool_id: str, username: str, password: str) -> bool:
    """True iff `password` is the actual FORCE_CHANGE_PASSWORD credential
    Cognito holds for `username` right now.

    Drives a real `admin_initiate_auth` (ADMIN_USER_PASSWORD_AUTH) against the
    moto fake pool rather than inspecting `create_user`'s own return value —
    the normalized user never carries the password (by design), so the only
    way to prove a *specific* value was actually set, as opposed to *some*
    value Cognito generated on its own, is to authenticate with it. The right
    password gets challenged to change it (`NEW_PASSWORD_REQUIRED`); a wrong
    one is rejected outright — moto enforces the credential value here even
    though (per manual probing) it does not enforce password complexity.
    """
    app_client_id = client.create_user_pool_client(
        UserPoolId=pool_id,
        ClientName=f"test-auth-{username}",
        ExplicitAuthFlows=["ADMIN_USER_PASSWORD_AUTH"],
    )["UserPoolClient"]["ClientId"]
    try:
        resp = client.admin_initiate_auth(
            UserPoolId=pool_id,
            ClientId=app_client_id,
            AuthFlow="ADMIN_USER_PASSWORD_AUTH",
            AuthParameters={"USERNAME": username, "PASSWORD": password},
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "NotAuthorizedException":
            return False
        raise
    return resp.get("ChallengeName") == "NEW_PASSWORD_REQUIRED"


def test_create_user_forwards_caller_supplied_temporary_password(pool):
    """The password the caller passed in is the password Cognito actually set

    — not merely *a* password Cognito generated on its own, which is the
    failure mode a no-op `temporary_password` param would produce (moto still
    creates the user and puts it in FORCE_CHANGE_PASSWORD either way, so a
    test that only checked user status would pass against that no-op too).
    """
    admin, client, pool_id = pool
    chosen = "Caller-Ch0sen-Passw0rd!"

    admin.create_user(
        email="judy@example.com",
        given_name="Judy",
        family_name="Jones",
        suppress_invite_email=True,
        temporary_password=chosen,
    )

    assert _password_reaches_cognito(client, pool_id, "judy@example.com", chosen)
    assert not _password_reaches_cognito(client, pool_id, "judy@example.com", "wrong-password-1!")


def test_create_user_without_temporary_password_leaves_cognito_to_generate_one(pool):
    """Omitting `temporary_password` is unchanged behaviour: Cognito still
    creates the user (FORCE_CHANGE_PASSWORD), just not with a password the
    caller chose — guards against the new parameter becoming accidentally
    required.
    """
    admin, _client, _pool_id = pool
    user = admin.create_user(
        email="ken@example.com",
        given_name="Ken",
        family_name="Kato",
        suppress_invite_email=True,
    )
    assert user["status"] == "FORCE_CHANGE_PASSWORD"


def test_create_user_response_never_includes_temporary_password(pool):
    admin, _client, _pool_id = pool
    secret = "Sup3r$ecretPassw0rd!"

    user = admin.create_user(
        email="ivan@example.com",
        given_name="Ivan",
        family_name="Ivanov",
        suppress_invite_email=True,
        temporary_password=secret,
    )

    assert secret not in str(user)


def test_create_user_redacts_temporary_password_from_cognito_errors():
    """If Cognito ever echoed a rejected TemporaryPassword back in an error
    message — moto and real Cognito both don't today, but nothing about the
    API contract promises that stays true — `create_user` must not let it
    through. Exercised with a mocked client raising exactly that shape,
    since neither moto nor real Cognito can be made to produce it on demand.
    """
    secret = "Ex0tic$ecretPassw0rd!"
    client = Mock()
    client.admin_create_user.side_effect = ClientError(
        {
            "Error": {
                "Code": "InvalidParameterException",
                "Message": (
                    f"Invalid parameter TemporaryPassword: {secret} does not conform to policy"
                ),
            }
        },
        "AdminCreateUser",
    )
    admin = CognitoAdmin(client=client, user_pool_id="pool-id", region=REGION)

    with pytest.raises(CognitoAdminError) as excinfo:
        admin.create_user(
            email="leo@example.com",
            given_name="Leo",
            family_name="Lin",
            temporary_password=secret,
        )

    # The secret never survives to the raised error...
    assert secret not in excinfo.value.message
    assert secret not in str(excinfo.value)
    # ...but the failure is still diagnosable, not blanked wholesale — the
    # other half of #1135/#1171's lesson: a "fix" that discards the whole
    # message is the other failure mode, and it's what made #1040 undiagnosable.
    assert "TemporaryPassword" in excinfo.value.message
    assert "does not conform to policy" in excinfo.value.message
    assert REDACTED in excinfo.value.message


# --- redact_secret ----------------------------------------------------------


def test_redact_secret_replaces_every_occurrence():
    secret = "tok++needs//no-escaping"
    text = f"raw {secret} and again {secret}"
    assert redact_secret(text, secret) == f"raw {REDACTED} and again {REDACTED}"


def test_redact_secret_treats_secret_literally_never_as_a_regex():
    # If this were compiled into a pattern, "x.x.x.x" would match "aXbXcXd".
    assert redact_secret("a.b.c.d", "x.x.x.x") == "a.b.c.d"


def test_redact_secret_ignores_none_and_implausibly_short_secrets():
    assert redact_secret("some error text", None) == "some error text"
    assert redact_secret("some error text", "") == "some error text"
    assert redact_secret("some error text", "short") == "some error text"


def test_redact_secret_preserves_surrounding_context():
    secret = "Sup3r$ecretPassw0rd!"
    out = redact_secret(f"AdminCreateUser failed: TemporaryPassword {secret} rejected", secret)
    assert secret not in out
    assert out == f"AdminCreateUser failed: TemporaryPassword {REDACTED} rejected"


# --- generate_temporary_password ---------------------------------------------


def test_generate_temporary_password_meets_cognito_default_complexity():
    password = generate_temporary_password()
    assert len(password) == 20
    assert any(c.isupper() for c in password)
    assert any(c.islower() for c in password)
    assert any(c.isdigit() for c in password)
    assert any(not c.isalnum() for c in password)


def test_generate_temporary_password_honours_custom_length():
    assert len(generate_temporary_password(length=32)) == 32


def test_generate_temporary_password_rejects_lengths_below_cognito_minimum():
    with pytest.raises(ValueError):
        generate_temporary_password(length=7)


def test_generate_temporary_password_is_not_constant():
    assert generate_temporary_password() != generate_temporary_password()


def test_generated_password_is_accepted_by_create_user(pool):
    """Round-trips a generated password through create_user and Cognito
    itself, proving the two halves of #950 compose: the generator's output is
    a value `create_user`'s `temporary_password` accepts and Cognito sets.
    """
    admin, client, pool_id = pool
    generated = generate_temporary_password()

    admin.create_user(
        email="mia@example.com",
        given_name="Mia",
        family_name="Moore",
        suppress_invite_email=True,
        temporary_password=generated,
    )

    assert _password_reaches_cognito(client, pool_id, "mia@example.com", generated)


# --- generated passwords must survive an HTML email body ----------------------
#
# The only reason to generate a temporary password is to put it somewhere
# Cognito will not: `admin_create_user` never returns the password it set, so an
# invite flow that sends a branded email must generate one and pass it as
# `TemporaryPassword`. That destination is HTML, and a password mangled in
# transit is a user who cannot sign in.
#
# tabsii-platform hit this in tabsii-crm#52 and narrowed its own copy of
# `_SYMBOLS`; the template's still carried `$` and `&`, so the next
# `biffo core upgrade` would have overwritten the instance's fix with the bug it
# was written to cure. This asserts the property rather than the string, so the
# set can be tuned without the guard going stale — and so it fails if a future
# edit reintroduces a hazardous character.

_HTML_HAZARDS = frozenset("&<>\"'\\$`")


def test_symbol_alphabet_excludes_characters_that_break_an_html_email():
    from api.cognito import _SYMBOLS

    offenders = sorted(set(_SYMBOLS) & _HTML_HAZARDS)
    assert offenders == [], (
        f"_SYMBOLS contains {offenders}, which do not survive an HTML email body "
        "(& starts an entity, $ is a templating token, quotes/brackets/backslash "
        "need escaping). See tabsii-crm#52."
    )


def test_generated_passwords_never_contain_an_html_hazard():
    # Sample rather than reason about the alphabet: this is what a caller
    # actually receives, and it would catch a hazard introduced anywhere in the
    # generation path, not only in `_SYMBOLS`.
    for _ in range(200):
        password = generate_temporary_password()
        assert not (set(password) & _HTML_HAZARDS), f"generated {password!r}"


# --- the generator's floor must be the pool's actual minimum -------------------


def test_minimum_length_matches_the_cognito_pool_terraform():
    """The constant is the pool's `minimum_length`, read from the Terraform.

    Asserted against the real module rather than restated, because the failure
    mode is silent drift: a generator permitting a shorter password than the
    pool accepts does not fail here, it fails inside `admin_create_user` as an
    opaque `InvalidParameterException`, at a call site that can no longer do
    anything about it.

    The template guarded at 8 while every pool it ships requires 12 — found
    while reconciling tabsii-platform's copy, which already had it right.
    """
    import re
    from pathlib import Path

    from api.cognito import COGNITO_MINIMUM_PASSWORD_LENGTH

    # services/api/tests/ -> services/api/ -> services/ -> repo root
    tf = Path(__file__).resolve().parents[3] / "modules/cloud/aws/auth/main.tf"
    assert tf.is_file(), f"cannot find the auth module at {tf} — has the layout moved?"

    match = re.search(r"minimum_length\s*=\s*(\d+)", tf.read_text())
    assert match is not None, "no minimum_length in the auth module — cannot verify the floor"

    assert COGNITO_MINIMUM_PASSWORD_LENGTH == int(match.group(1)), (
        f"COGNITO_MINIMUM_PASSWORD_LENGTH is {COGNITO_MINIMUM_PASSWORD_LENGTH} but the pool "
        f"requires {match.group(1)} — a password between the two is generated here and "
        "rejected by Cognito."
    )


def test_generate_temporary_password_rejects_a_length_the_pool_would_reject():
    import pytest as _pytest
    from api.cognito import COGNITO_MINIMUM_PASSWORD_LENGTH

    with _pytest.raises(ValueError, match="at least 12"):
        generate_temporary_password(length=COGNITO_MINIMUM_PASSWORD_LENGTH - 1)
