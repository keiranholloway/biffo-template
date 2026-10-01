"""A tiny in-memory fake of the Core API's generic CRUD routes
(`/api/v1/plugins/example-plugin/*`), used to test this plugin without a
real Core API or network call.

Mirrors the shape `build_plugin_router` in
`services/api/src/api/routing/plugin_router.py` (biffo-template monorepo)
actually produces (id auto-assigned, tenant_id auto-assigned, list/create/
read/delete by path), so these tests exercise realistic request/response
semantics rather than hand-picked canned responses. Copied from the RBAC
reference plugin's `services/rbac/tests/fakes.py` (PR #76) and trimmed to
this plugin's single `widgets` resource.
"""

from __future__ import annotations

import json
from itertools import count
from typing import Any

import httpx
from biffo_plugin_sdk import BiffoAPIClient, ManifestSchema, SchemaViolation, load_manifest

from example_plugin.manifest import MANIFEST_PATH

_BASE_PATH = "/api/v1/plugins/example-plugin"


class FakeCoreApi:
    """Fake backing store for the plugin's own generic CRUD routes.

    Rejects what production rejects: on create it validates the payload
    against the column bounds, types and NOT NULLs *generated from this
    plugin's own `biffo.plugin.json` table declarations* (SDK `ManifestSchema`),
    returning 422 like Core. Nothing here hand-writes a bound, so a manifest
    change (e.g. `String(100)` -> `String(64)`) changes the fake with it.
    """

    def __init__(self) -> None:
        self._manifest = load_manifest(MANIFEST_PATH)
        self._schema = ManifestSchema.from_manifest(self._manifest)
        self.tables: dict[str, list[dict[str, Any]]] = {"widgets": []}
        self.request_log: list[tuple[str, str]] = []
        self._ids = count(1)

    def client(self) -> BiffoAPIClient:
        transport = httpx.MockTransport(self._handle)
        async_client = httpx.AsyncClient(transport=transport)
        return BiffoAPIClient(
            base_url="https://core.example.com", token="test-jwt", client=async_client
        )

    def _handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        assert path.startswith(_BASE_PATH), f"unexpected path: {path}"
        self.request_log.append((request.method, path))

        rest = path[len(_BASE_PATH) :].strip("/")
        parts = rest.split("/") if rest else []
        table = parts[0]
        row_id = parts[1] if len(parts) > 1 else None
        rows = self.tables.setdefault(table, [])

        if request.method == "GET" and row_id is None:
            return httpx.Response(200, json=rows)

        if request.method == "GET" and row_id is not None:
            row = next((r for r in rows if r["id"] == row_id), None)
            if row is None:
                return httpx.Response(404, json={"detail": "Not found"})
            return httpx.Response(200, json=row)

        if request.method == "POST":
            payload = json.loads(request.content or b"{}")
            declared = self._schema.table_for_route(self._manifest, table)
            if declared is not None:
                try:
                    self._schema.validate(declared, payload)
                except SchemaViolation as exc:
                    return httpx.Response(422, json={"detail": exc.problems})
            row = {"id": f"id-{next(self._ids)}", "tenant_id": "default", **payload}
            rows.append(row)
            return httpx.Response(201, json=row)

        if request.method == "DELETE" and row_id is not None:
            before = len(rows)
            self.tables[table] = [r for r in rows if r["id"] != row_id]
            if len(self.tables[table]) == before:
                return httpx.Response(404, json={"detail": "Not found"})
            return httpx.Response(200, json={"deleted": True, "id": row_id})

        return httpx.Response(404, json={"detail": "Not found"})
