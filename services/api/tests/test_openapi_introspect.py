"""Unit tests for the OpenAPI introspection helpers (openapi_introspect.py).

Pure functions over a hand-built OpenAPI dict — no FastAPI app needed."""

from api.openapi_introspect import build_endpoint_detail, collect_openapi_endpoints
from api.schemas.endpoint import EndpointResponse

OPENAPI = {
    "paths": {
        "/api/v1/public/demo-requests": {
            "post": {
                "summary": "Submit demo request",
                "tags": ["public"],
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": {
                                "$ref": "#/components/schemas/DemoRequestRequest"
                            }
                        }
                    }
                },
                "responses": {
                    "201": {
                        "description": "Created",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "$ref": "#/components/schemas/DemoRequestResponse"
                                }
                            }
                        },
                    },
                    "422": {"description": "Validation Error"},
                },
            }
        },
        "/api/v1/data/widgets/{id}": {
            "get": {
                "summary": "read widgets",
                "tags": ["data:widgets"],
                "parameters": [
                    {
                        "name": "id",
                        "in": "path",
                        "required": True,
                        "schema": {"type": "string"},
                    }
                ],
                "responses": {"200": {"description": "OK"}},
            }
        },
    },
    "components": {
        "schemas": {
            "DemoRequestRequest": {
                "type": "object",
                "required": ["name", "email", "company"],
                "properties": {
                    "name": {"type": "string", "maxLength": 200},
                    "email": {"type": "string", "format": "email"},
                    "company": {"type": "string"},
                    "message": {
                        "anyOf": [{"type": "string"}, {"type": "null"}],
                        "description": "optional note",
                    },
                    "status": {"enum": ["new", "contacted"], "type": "string"},
                },
            },
            "DemoRequestResponse": {
                "type": "object",
                "required": ["id", "status"],
                "properties": {"id": {"type": "string"}, "status": {"type": "string"}},
            },
        }
    },
}


class TestBuildEndpointDetail:
    def test_resolves_request_body_fields_and_example(self):
        detail = build_endpoint_detail(OPENAPI, "POST", "/api/v1/public/demo-requests")
        assert detail is not None
        assert detail.summary == "Submit demo request"
        body = detail.request_body
        assert body is not None
        assert body.content_type == "application/json"

        by_name = {f.name: f for f in body.fields}
        assert set(by_name) == {"name", "email", "company", "message", "status"}
        assert by_name["name"].required is True
        assert by_name["message"].required is False
        # anyOf[string,null] collapses to a readable union label.
        assert by_name["message"].type == "string | null"
        assert by_name["message"].description == "optional note"
        # format + enum surface as notes.
        assert "format: email" in (by_name["email"].notes or "")
        assert "one of: new, contacted" in (by_name["status"].notes or "")

        # A synthesized example is produced from the $ref-resolved schema.
        assert body.example["name"] == "string"
        assert body.example["status"] == "new"  # first enum value

    def test_responses_include_schema_and_bare_status(self):
        detail = build_endpoint_detail(OPENAPI, "POST", "/api/v1/public/demo-requests")
        assert detail is not None
        by_code = {r.status_code: r for r in detail.responses}
        assert set(by_code) == {"201", "422"}
        created = by_code["201"]
        assert {f.name for f in created.fields} == {"id", "status"}
        assert created.example == {"id": "string", "status": "string"}
        # 422 has no JSON content -> description only, no fields.
        assert by_code["422"].fields == []
        assert by_code["422"].content_type is None

    def test_path_parameters_surfaced(self):
        detail = build_endpoint_detail(OPENAPI, "GET", "/api/v1/data/widgets/{id}")
        assert detail is not None
        assert detail.request_body is None
        assert [(p.name, p.location, p.required) for p in detail.parameters] == [
            ("id", "path", True)
        ]

    def test_unknown_route_returns_none(self):
        assert build_endpoint_detail(OPENAPI, "GET", "/api/v1/nope") is None
        assert (
            build_endpoint_detail(OPENAPI, "DELETE", "/api/v1/public/demo-requests")
            is None
        )


class TestCollectOpenapiEndpoints:
    def test_lists_all_routes_enriched_where_crud_matches(self):
        crud = [
            EndpointResponse(
                source="core",
                table="widgets",
                operation="read",
                method="GET",
                path="/api/v1/data/widgets/{id}",
                required_role=[],
            )
        ]
        rows = collect_openapi_endpoints(OPENAPI, crud)
        by_key = {(r.method, r.path): r for r in rows}

        # Both routes present, sorted by path then method.
        assert [(r.method, r.path) for r in rows] == sorted(
            (r.method, r.path) for r in rows
        )

        widget = by_key[("GET", "/api/v1/data/widgets/{id}")]
        assert widget.source == "core"
        assert widget.table == "widgets"
        assert widget.permission_editable is False  # core rows change in code
        assert widget.summary == "read widgets"

        demo = by_key[("POST", "/api/v1/public/demo-requests")]
        assert demo.source == "bespoke"
        assert demo.required_role is None  # unknown for bespoke
        assert demo.permission_editable is False
        assert demo.tags == ["public"]

    def test_plugin_rows_are_permission_editable(self):
        crud = [
            EndpointResponse(
                source="plugin",
                plugin="notepad",
                table="notes",
                operation="create",
                method="POST",
                path="/api/v1/public/demo-requests",  # pretend match for the test
                required_role=["admin"],
            )
        ]
        rows = collect_openapi_endpoints(OPENAPI, crud)
        match = next(r for r in rows if r.path == "/api/v1/public/demo-requests")
        assert match.source == "plugin"
        assert match.permission_editable is True
        assert match.required_role == ["admin"]
