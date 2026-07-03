from fastapi.testclient import TestClient


def test_whoami_returns_username_for_authenticated_caller(authenticated_client: TestClient) -> None:
    response = authenticated_client.get("/api/v1/whoami")

    assert response.status_code == 200
    assert response.json() == {"username": "testuser"}


def test_whoami_rejects_unauthenticated_requests(client: TestClient) -> None:
    response = client.get("/api/v1/whoami")

    assert response.status_code == 401  # No Authorization header at all — HTTPBearer's own 401


def test_health_requires_no_auth(client: TestClient) -> None:
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
