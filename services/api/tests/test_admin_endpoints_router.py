"""Tests for the /admin/endpoints listing (ADR-0004 endpoints view)."""

from api.routers.admin.endpoints import collect_endpoints


def _fake_core_model(tablename, perms, name="FakeCoreModel"):
    return type(name, (), {"__tablename__": tablename, "__crud_permissions__": perms})


def _manifest(name, table, permissions, routes):
    return {
        "name": name,
        "version": "1.0.0",
        "tables": [{"name": table, "permissions": permissions}],
        "api_routes": routes,
    }


class TestCollectEndpoints:
    def test_plugin_routes_only_included_when_allowed(self):
        manifest = _manifest(
            "notepad",
            "notes",
            {
                "list": {"allowed": True},
                "read": {"allowed": False},  # declared route but not exposed
                "create": {"allowed": True, "required_role": ["admin"]},
            },
            [
                {
                    "method": "GET",
                    "path": "/notes",
                    "table": "notes",
                    "operation": "list",
                },
                {
                    "method": "GET",
                    "path": "/notes/{id}",
                    "table": "notes",
                    "operation": "read",
                },
                {
                    "method": "POST",
                    "path": "/notes",
                    "table": "notes",
                    "operation": "create",
                },
            ],
        )
        eps = collect_endpoints([manifest], core_models=[])
        paths = {(e.method, e.path, tuple(e.required_role)) for e in eps}
        assert ("GET", "/api/v1/plugins/notepad/notes", ()) in paths
        assert ("POST", "/api/v1/plugins/notepad/notes", ("admin",)) in paths
        # read is declared but not allowed -> not live
        assert all(e.operation != "read" for e in eps)
        assert all(e.source == "plugin" and e.plugin == "notepad" for e in eps)

    def test_core_table_allowed_operations(self):
        model = _fake_core_model(
            "widgets",
            {
                "list": {"allowed": True},
                "read": {"allowed": True},
                "delete": {"allowed": True, "required_role": ["admin"]},
                # create/update omitted -> not exposed
            },
        )
        eps = collect_endpoints([], core_models=[model])
        got = {(e.method, e.path, tuple(e.required_role), e.source) for e in eps}
        assert ("GET", "/api/v1/data/widgets", (), "core") in got
        assert ("GET", "/api/v1/data/widgets/{id}", (), "core") in got
        assert ("DELETE", "/api/v1/data/widgets/{id}", ("admin",), "core") in got
        assert not any(e.operation in ("create", "update") for e in eps)

    def test_empty_when_nothing_exposed(self):
        model = _fake_core_model("hidden", {})  # fully default-deny
        manifest = _manifest("p", "t", {}, [])
        assert collect_endpoints([manifest], core_models=[model]) == []

    def test_sorted_by_path_then_method(self):
        model = _fake_core_model(
            "zeta", {"list": {"allowed": True}, "create": {"allowed": True}}
        )
        manifest = _manifest(
            "alpha",
            "alpha_t",
            {"list": {"allowed": True}},
            [{"method": "GET", "path": "/x", "table": "alpha_t", "operation": "list"}],
        )
        eps = collect_endpoints([manifest], core_models=[model])
        paths = [e.path for e in eps]
        assert paths == sorted(paths)

    def test_invalid_core_permissions_skipped_not_fatal(self):
        good = _fake_core_model("good", {"list": {"allowed": True}})
        bad = _fake_core_model("bad", {"delet": {"allowed": True}})  # typo'd op
        eps = collect_endpoints([], core_models=[bad, good])
        assert {e.table for e in eps} == {"good"}


class TestEndpointsRoute:
    """HTTP layer: auth required, returns the live endpoints for this deployment
    (which includes the on-disk rbac plugin)."""

    def _client(self, roles=("admin",)):
        from fastapi.testclient import TestClient

        from api.main import app
        from api.middleware.auth import AuthenticatedUser, require_auth

        app.dependency_overrides[require_auth] = lambda: AuthenticatedUser(
            sub="s",
            email="e@x.com",
            username="u",
            tenant_id="default",
            roles=list(roles),
        )
        return app, TestClient(app)

    def test_lists_live_endpoints(self):
        app, client = self._client()
        try:
            resp = client.get("/api/v1/admin/endpoints")
            assert resp.status_code == 200
            data = resp.json()
            assert isinstance(data, list)
            # the rbac plugin is installed on disk -> its allowed routes are live
            assert any(e["path"].startswith("/api/v1/plugins/rbac/") for e in data)
            # every item carries the shape the portal renders
            for e in data:
                assert {
                    "source",
                    "table",
                    "operation",
                    "method",
                    "path",
                    "required_role",
                } <= e.keys()
        finally:
            app.dependency_overrides.clear()

    def test_requires_auth(self):
        from fastapi.testclient import TestClient

        from api.main import app

        resp = TestClient(app).get("/api/v1/admin/endpoints")
        assert resp.status_code in (401, 403)


class TestChangePermissionRoute:
    """POST /admin/endpoints/permission (ADR-0008): admin-only; invokes the
    isolated PR-signer and relays its result. No live mutation happens here."""

    VALID_BODY = {
        "plugin": "notes",
        "table": "note",
        "operation": "create",
        "allowed": True,
        "required_role": ["admin"],
    }

    def _client(
        self, monkeypatch, *, roles=("admin",), invoker=None, function_name="signer-fn"
    ):
        from fastapi.testclient import TestClient

        from api.config import settings
        from api.main import app
        from api.middleware.auth import AuthenticatedUser, require_auth
        from api.routers.admin import endpoints

        monkeypatch.setattr(settings, "pr_signer_function_name", function_name)
        if invoker is not None:
            monkeypatch.setattr(endpoints, "_invoker", invoker)

        app.dependency_overrides[require_auth] = lambda: AuthenticatedUser(
            sub="s",
            email="admin@example.com",
            username="u",
            tenant_id="default",
            roles=list(roles),
        )
        return app, TestClient(app)

    class _FakeInvoker:
        def __init__(self, result=None, raises=None):
            self.result = result
            self.raises = raises
            self.payload = None

        def invoke(self, payload):
            self.payload = payload
            if self.raises is not None:
                raise self.raises
            return self.result

    def test_success_returns_202_with_pr(self, monkeypatch):
        invoker = self._FakeInvoker(
            {
                "statusCode": 200,
                "pr_url": "https://github.com/o/r/pull/9",
                "branch": "biffo/endpoint-notes",
            }
        )
        app, client = self._client(monkeypatch, invoker=invoker)
        try:
            resp = client.post(
                "/api/v1/admin/endpoints/permission", json=self.VALID_BODY
            )
            assert resp.status_code == 202
            assert resp.json() == {
                "pr_url": "https://github.com/o/r/pull/9",
                "branch": "biffo/endpoint-notes",
            }
            # The requester is attributed from the verified identity.
            assert invoker.payload is not None
            assert invoker.payload["requester"] == "admin@example.com"
            assert invoker.payload["plugin"] == "notes"
        finally:
            app.dependency_overrides.clear()

    def test_non_admin_forbidden(self, monkeypatch):
        invoker = self._FakeInvoker({"statusCode": 200, "pr_url": "u", "branch": "b"})
        app, client = self._client(monkeypatch, roles=("editor",), invoker=invoker)
        try:
            resp = client.post(
                "/api/v1/admin/endpoints/permission", json=self.VALID_BODY
            )
            assert resp.status_code == 403
            # A non-admin never reaches the signer.
            assert invoker.payload is None
        finally:
            app.dependency_overrides.clear()

    def test_not_configured_returns_501(self, monkeypatch):
        app, client = self._client(monkeypatch, function_name="")
        try:
            resp = client.post(
                "/api/v1/admin/endpoints/permission", json=self.VALID_BODY
            )
            assert resp.status_code == 501
        finally:
            app.dependency_overrides.clear()

    def test_signer_conflict_relayed_as_409(self, monkeypatch):
        invoker = self._FakeInvoker(
            {"statusCode": 409, "error": "already set that way"}
        )
        app, client = self._client(monkeypatch, invoker=invoker)
        try:
            resp = client.post(
                "/api/v1/admin/endpoints/permission", json=self.VALID_BODY
            )
            assert resp.status_code == 409
            assert "already set" in resp.json()["detail"]
        finally:
            app.dependency_overrides.clear()

    def test_signer_bad_request_relayed_as_400(self, monkeypatch):
        invoker = self._FakeInvoker({"statusCode": 400, "error": "bad event"})
        app, client = self._client(monkeypatch, invoker=invoker)
        try:
            resp = client.post(
                "/api/v1/admin/endpoints/permission", json=self.VALID_BODY
            )
            assert resp.status_code == 400
        finally:
            app.dependency_overrides.clear()

    def test_signer_upstream_error_becomes_502(self, monkeypatch):
        from api.endpoint_control import SignerInvocationError

        invoker = self._FakeInvoker(raises=SignerInvocationError("signer down"))
        app, client = self._client(monkeypatch, invoker=invoker)
        try:
            resp = client.post(
                "/api/v1/admin/endpoints/permission", json=self.VALID_BODY
            )
            assert resp.status_code == 502
        finally:
            app.dependency_overrides.clear()

    def test_invalid_operation_rejected_by_validation(self, monkeypatch):
        invoker = self._FakeInvoker({"statusCode": 200, "pr_url": "u", "branch": "b"})
        app, client = self._client(monkeypatch, invoker=invoker)
        try:
            resp = client.post(
                "/api/v1/admin/endpoints/permission",
                json={**self.VALID_BODY, "operation": "drop"},
            )
            assert resp.status_code == 422
            assert invoker.payload is None
        finally:
            app.dependency_overrides.clear()
