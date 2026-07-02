"""Tests for plugin route definition models (issue #19)."""

import pytest
from pydantic import ValidationError

from api.models.plugin_route import RouteDefinition, parse_plugin_routes_from_manifest


class TestRouteDefinition:
    def test_minimal_list_route(self):
        route = RouteDefinition(
            method="GET", path="/widgets", table="widgets", operation="list"
        )
        assert route.method == "GET"
        assert route.path == "/widgets"
        assert route.table == "widgets"
        assert route.operation == "list"
        assert route.description == ""

    def test_read_route_requires_id_path_param(self):
        with pytest.raises(ValidationError):
            RouteDefinition(
                method="GET", path="/widgets", table="widgets", operation="read"
            )

    def test_read_route_with_id_is_valid(self):
        route = RouteDefinition(
            method="GET", path="/widgets/{id}", table="widgets", operation="read"
        )
        assert route.path == "/widgets/{id}"

    def test_list_route_rejects_id_path_param(self):
        with pytest.raises(ValidationError):
            RouteDefinition(
                method="GET", path="/widgets/{id}", table="widgets", operation="list"
            )

    def test_create_requires_post(self):
        with pytest.raises(ValidationError):
            RouteDefinition(
                method="GET", path="/widgets", table="widgets", operation="create"
            )
        route = RouteDefinition(
            method="POST", path="/widgets", table="widgets", operation="create"
        )
        assert route.method == "POST"

    def test_update_accepts_put_or_patch_only(self):
        RouteDefinition(
            method="PUT", path="/widgets/{id}", table="widgets", operation="update"
        )
        RouteDefinition(
            method="PATCH", path="/widgets/{id}", table="widgets", operation="update"
        )
        with pytest.raises(ValidationError):
            RouteDefinition(
                method="GET", path="/widgets/{id}", table="widgets", operation="update"
            )

    def test_delete_requires_delete_method_and_id(self):
        RouteDefinition(
            method="DELETE", path="/widgets/{id}", table="widgets", operation="delete"
        )
        with pytest.raises(ValidationError):
            RouteDefinition(
                method="DELETE", path="/widgets", table="widgets", operation="delete"
            )

    def test_path_must_start_with_slash(self):
        with pytest.raises(ValidationError):
            RouteDefinition(
                method="GET", path="widgets", table="widgets", operation="list"
            )


class TestParsePluginRoutesFromManifest:
    def test_no_routes_key_returns_empty_list(self):
        assert (
            parse_plugin_routes_from_manifest({"name": "x", "version": "1.0.0"}) == []
        )

    def test_empty_routes_list_returns_empty_list(self):
        manifest = {"name": "x", "version": "1.0.0", "api_routes": []}
        assert parse_plugin_routes_from_manifest(manifest) == []

    def test_parses_valid_routes(self):
        manifest = {
            "name": "gizmos",
            "version": "1.0.0",
            "tables": [{"name": "gizmos", "columns": []}],
            "api_routes": [
                {
                    "method": "GET",
                    "path": "/gizmos",
                    "table": "gizmos",
                    "operation": "list",
                },
                {
                    "method": "POST",
                    "path": "/gizmos",
                    "table": "gizmos",
                    "operation": "create",
                },
            ],
        }
        routes = parse_plugin_routes_from_manifest(manifest)
        assert len(routes) == 2
        assert routes[0].operation == "list"
        assert routes[1].operation == "create"

    def test_route_referencing_unknown_table_raises(self):
        manifest = {
            "name": "gizmos",
            "version": "1.0.0",
            "tables": [{"name": "gizmos", "columns": []}],
            "api_routes": [
                {
                    "method": "GET",
                    "path": "/widgets",
                    "table": "widgets",
                    "operation": "list",
                }
            ],
        }
        with pytest.raises(ValueError, match="widgets"):
            parse_plugin_routes_from_manifest(manifest)

    def test_route_with_no_tables_declared_raises(self):
        manifest = {
            "name": "gizmos",
            "version": "1.0.0",
            "api_routes": [
                {
                    "method": "GET",
                    "path": "/gizmos",
                    "table": "gizmos",
                    "operation": "list",
                }
            ],
        }
        with pytest.raises(ValueError):
            parse_plugin_routes_from_manifest(manifest)

    def test_duplicate_method_and_path_raises(self):
        manifest = {
            "name": "gizmos",
            "version": "1.0.0",
            "tables": [{"name": "gizmos", "columns": []}],
            "api_routes": [
                {
                    "method": "GET",
                    "path": "/gizmos",
                    "table": "gizmos",
                    "operation": "list",
                },
                {
                    "method": "GET",
                    "path": "/gizmos",
                    "table": "gizmos",
                    "operation": "list",
                },
            ],
        }
        with pytest.raises(ValueError, match="Duplicate"):
            parse_plugin_routes_from_manifest(manifest)

    def test_invalid_route_shape_raises_validation_error(self):
        manifest = {
            "name": "gizmos",
            "version": "1.0.0",
            "tables": [{"name": "gizmos", "columns": []}],
            "api_routes": [{"method": "GET", "table": "gizmos", "operation": "list"}],
        }
        with pytest.raises(ValidationError):
            parse_plugin_routes_from_manifest(manifest)
