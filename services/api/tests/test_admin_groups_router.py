"""Tests for the admin groups endpoint (/api/v1/admin/groups, issue #148).

Drives the HTTP layer via TestClient against a moto fake Cognito pool. Groups
listing needs no DB, so this harness is lighter than the users-router one.
"""

from collections.abc import Generator

import boto3
import pytest
from api.cognito import CognitoAdmin
from api.dependencies import get_cognito_admin
from api.middleware.auth import AuthenticatedUser, require_auth
from api.routers.admin import groups as admin_groups
from fastapi import FastAPI
from fastapi.testclient import TestClient
from moto import mock_aws

REGION = "us-east-1"
_BASE = "/api/v1/admin/groups"


def _caller(roles: list[str]) -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="s",
        email="admin@example.com",
        username="admin",
        tenant_id="default",
        roles=roles,
    )


@pytest.fixture
def harness() -> Generator[dict]:
    with mock_aws():
        client = boto3.client("cognito-idp", region_name=REGION)
        pool_id = client.create_user_pool(PoolName="test")["UserPool"]["Id"]
        for group in ("admin", "editor", "viewer", "billing"):
            client.create_group(UserPoolId=pool_id, GroupName=group)
        cog = CognitoAdmin(client=client, user_pool_id=pool_id, region=REGION)

        app = FastAPI()
        app.include_router(admin_groups.router, prefix="/api/v1")
        app.dependency_overrides[get_cognito_admin] = lambda: cog
        app.dependency_overrides[require_auth] = lambda: _caller(["admin"])

        yield {"app": app, "client": TestClient(app)}


def test_lists_the_pools_groups(harness):
    resp = harness["client"].get(_BASE)
    assert resp.status_code == 200
    # Reflects the deployment's actual taxonomy, including a custom "billing" group.
    assert set(resp.json()["groups"]) == {"admin", "editor", "viewer", "billing"}


def test_requires_admin(harness):
    harness["app"].dependency_overrides[require_auth] = lambda: _caller(["viewer"])
    resp = harness["client"].get(_BASE)
    assert resp.status_code == 403


def test_requires_authentication():
    with mock_aws():
        client = boto3.client("cognito-idp", region_name=REGION)
        pool_id = client.create_user_pool(PoolName="test")["UserPool"]["Id"]
        cog = CognitoAdmin(client=client, user_pool_id=pool_id, region=REGION)
        app = FastAPI()
        app.include_router(admin_groups.router, prefix="/api/v1")
        app.dependency_overrides[get_cognito_admin] = lambda: cog
        resp = TestClient(app).get(_BASE)
        assert resp.status_code in (401, 403)
