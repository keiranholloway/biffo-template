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
