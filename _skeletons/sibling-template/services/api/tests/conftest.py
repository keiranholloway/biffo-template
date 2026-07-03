from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient

from api.main import app
from api.middleware.auth import AuthenticatedUser, require_auth


@pytest.fixture
def authenticated_client() -> Generator[TestClient]:
    app.dependency_overrides[require_auth] = lambda: AuthenticatedUser(
        sub="abc-123",
        email="a@example.com",
        username="testuser",
    )
    client = TestClient(app)
    yield client
    app.dependency_overrides.pop(require_auth, None)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)
