"""Unit tests for the CognitoAdmin adapter, exercised against a moto fake pool."""

import boto3
import pytest
from api.cognito import CognitoAdmin, CognitoAdminError
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
