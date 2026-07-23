"""ADR-0004: build-time permissions registry (services/api/src/api/permissions.py)."""

import api.permissions as permissions_module
import pytest
from api.models.plugin_table import PermissionRule, TablePermissions
from api.permissions import (
    build_permissions_registry,
    get_permissions_registry,
    lookup_permission,
    serialize_registry,
)


def _manifest(name, tables):
    return {"name": name, "version": "1.0.0", "tables": tables}


def _fake_core_model(tablename, perms, name="FakeCoreModel"):
    """Class stand-in for a core TenantScopedModel subclass. build_permissions_registry
    only reads __tablename__/__crud_permissions__, so a bare class (not a real
    mapped model) avoids registering a table on Base.metadata that would leak
    across tests. Returns a class, matching the real `Iterable[type]` contract."""
    return type(name, (), {"__tablename__": tablename, "__crud_permissions__": perms})


class TestBuildFromPlugins:
    def test_plugin_table_permissions_are_included(self):
        manifest = _manifest(
            "gizmos",
            [
                {
                    "name": "widgets",
                    "columns": [{"name": "label", "type": "String(100)"}],
                    "permissions": {
                        "list": {"allowed": True},
                        "read": {"allowed": True},
                        "create": {"allowed": True, "required_role": ["editor"]},
                    },
                }
            ],
        )
        registry = build_permissions_registry([manifest], core_models=[])

        assert set(registry) == {"widgets"}
        block = registry["widgets"]
        assert block.list.allowed is True
        assert block.create.allowed is True
        assert block.create.required_role == ["editor"]
        # Unmentioned ops stay default-deny.
        assert block.update.allowed is False
        assert block.delete.allowed is False

    def test_plugin_table_without_permissions_defaults_fully_denied(self):
        manifest = _manifest("gizmos", [{"name": "widgets"}])
        registry = build_permissions_registry([manifest], core_models=[])

        assert "widgets" in registry
        for op in ("list", "read", "create", "update", "delete"):
            assert getattr(registry["widgets"], op).allowed is False

    def test_invalid_manifest_skipped_nonstrict_but_raises_strict(self):
        # A table redeclaring a reserved auto-column fails PluginTableDefinition.
        bad = _manifest(
            "broken",
            [
                {
                    "name": "widgets",
                    "columns": [{"name": "tenant_id", "type": "String(64)"}],
                }
            ],
        )
        assert build_permissions_registry([bad], core_models=[]) == {}
        with pytest.raises(Exception):  # noqa: B017 — asserting strict mode raises at all
            build_permissions_registry([bad], core_models=[], strict=True)


class TestBuildFromCoreModels:
    def test_core_model_with_crud_permissions_included(self):
        model = _fake_core_model(
            "audit_log", {"read": {"allowed": True, "required_role": ["admin"]}}
        )
        registry = build_permissions_registry([], core_models=[model])

        assert registry["audit_log"].read.allowed is True
        assert registry["audit_log"].read.required_role == ["admin"]
        assert registry["audit_log"].create.allowed is False

    def test_invalid_core_permissions_skipped_nonstrict_raises_strict(self):
        model = _fake_core_model("audit_log", {"delet": {"allowed": True}})  # typo'd op

        assert build_permissions_registry([], core_models=[model]) == {}
        with pytest.raises(Exception):  # noqa: B017 — asserting strict mode raises at all
            build_permissions_registry([], core_models=[model], strict=True)

    def test_default_core_walk_excludes_models_without_permissions(self):
        # User is a real core model with no __crud_permissions__; it must not be
        # exposed by the default core walk.
        from api.models.user import User  # noqa: F401 — registers the model

        registry = build_permissions_registry([])  # default core_models discovery
        assert "users" not in registry


class TestCollisions:
    def test_duplicate_table_keeps_first_nonstrict_and_raises_strict(self):
        manifest = _manifest(
            "gizmos", [{"name": "widgets", "permissions": {"read": {"allowed": True}}}]
        )
        core = _fake_core_model("widgets", {"read": {"allowed": False}})

        # Plugin processed first, so it wins; the core duplicate is dropped.
        registry = build_permissions_registry([manifest], core_models=[core])
        assert registry["widgets"].read.allowed is True

        with pytest.raises(ValueError):
            build_permissions_registry([manifest], core_models=[core], strict=True)


class TestSerialize:
    def test_serialize_shape(self):
        registry = {
            "widgets": TablePermissions.model_validate(
                {"read": {"allowed": True, "required_role": ["admin"]}}
            )
        }
        dumped = serialize_registry(registry)
        assert dumped["widgets"]["read"] == {
            "allowed": True,
            "required_role": ["admin"],
            "allowed_principals": [],
        }
        assert dumped["widgets"]["list"] == {
            "allowed": False,
            "required_role": [],
            "allowed_principals": [],
        }


class TestLookup:
    def _registry(self):
        return {
            "widgets": TablePermissions.model_validate(
                {"read": {"allowed": True, "required_role": ["admin"]}}
            )
        }

    def test_absent_table_returns_none(self):
        assert lookup_permission("nope", "read", registry=self._registry()) is None

    def test_present_operation_returns_rule(self):
        rule = lookup_permission("widgets", "read", registry=self._registry())
        assert isinstance(rule, PermissionRule)
        assert rule.allowed is True
        assert rule.required_role == ["admin"]

    def test_denied_operation_returns_rule_with_allowed_false(self):
        rule = lookup_permission("widgets", "delete", registry=self._registry())
        assert rule is not None
        assert rule.allowed is False

    def test_unknown_operation_returns_none(self):
        assert lookup_permission("widgets", "frobnicate", registry=self._registry()) is None


class TestGetRegistryCaching:
    def test_memoized_until_force_rebuild(self, monkeypatch):
        monkeypatch.setattr(permissions_module, "_REGISTRY_CACHE", None)
        first = get_permissions_registry()
        second = get_permissions_registry()
        assert first is second  # same object — memoised, not rebuilt

        rebuilt = get_permissions_registry(force_rebuild=True)
        assert rebuilt is not first

    def test_fails_closed_to_empty_registry_on_build_error(self, monkeypatch):
        monkeypatch.setattr(permissions_module, "_REGISTRY_CACHE", None)

        def _boom(*args, **kwargs):
            raise RuntimeError("manifest disk on fire")

        monkeypatch.setattr(permissions_module, "build_permissions_registry", _boom)
        assert get_permissions_registry() == {}
