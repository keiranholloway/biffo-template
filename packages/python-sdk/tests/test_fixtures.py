"""Tests for captured-fixture recording and manifest-generated schema enforcement."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest
from biffo_plugin_sdk import (
    FixtureNotRecordedError,
    FixtureRecorder,
    ManifestSchema,
    PluginManifest,
    SchemaViolation,
)

CAPTURED = Path(__file__).parent / "captured"


def _manifest() -> PluginManifest:
    return PluginManifest.model_validate(
        {
            "name": "chan",
            "version": "0.1.0",
            "description": "d",
            "author": "a",
            "required_core_version": ">=0.0.0",
            "tables": [
                {
                    "name": "chan_channels",
                    "columns": [
                        {"name": "name", "type": "String(64)", "nullable": False},
                        {"name": "notes", "type": "Text", "nullable": True},
                        {"name": "size", "type": "Integer", "nullable": True},
                    ],
                }
            ],
            "api_routes": [
                {
                    "method": "POST",
                    "path": "/channels",
                    "table": "chan_channels",
                    "operation": "create",
                    "description": "x",
                }
            ],
        }
    )


class TestCapturedAgentOutputRejected:
    """The biffo-plugin-marketing#75 shape: a real LLM-chosen channel name
    (121 chars) against a declared varchar(64)."""

    def test_captured_output_longer_than_declared_bound_is_rejected(self) -> None:
        captured = FixtureRecorder(CAPTURED).load("agent_channel_name")
        assert len(captured["name"]) > 64
        schema = ManifestSchema.from_manifest(_manifest())
        with pytest.raises(
            SchemaViolation, match=r"name is 121 characters, exceeds declared String\(64\)"
        ):
            schema.validate("chan_channels", captured)

    def test_disagreement_widen_fixture_past_bound_and_fake_rejects(self) -> None:
        schema = ManifestSchema.from_manifest(_manifest())
        ok = {"name": "x" * 64}
        schema.validate("chan_channels", ok)
        widened = copy.deepcopy(ok)
        widened["name"] += "x"
        with pytest.raises(SchemaViolation):
            schema.validate("chan_channels", widened)

    def test_bound_is_read_from_the_manifest_not_hardcoded(self) -> None:
        raw = _manifest().model_dump(mode="json")
        raw["tables"][0]["columns"] = [
            c
            for c in raw["tables"][0]["columns"]
            if c["name"] not in {"id", "tenant_id", "created_at", "updated_at"}
        ]
        raw["tables"][0]["columns"][0]["type"] = "String(500)"
        schema = ManifestSchema.from_manifest(PluginManifest.model_validate(raw))
        schema.validate("chan_channels", {"name": "x" * 121})


class TestTypesAndNotNull:
    def test_missing_not_null_column(self) -> None:
        schema = ManifestSchema.from_manifest(_manifest())
        with pytest.raises(SchemaViolation, match="name is NOT NULL"):
            schema.validate("chan_channels", {"notes": "hi"})

    def test_explicit_null_on_not_null(self) -> None:
        schema = ManifestSchema.from_manifest(_manifest())
        with pytest.raises(SchemaViolation, match="NOT NULL"):
            schema.validate("chan_channels", {"name": None})

    def test_nullable_accepts_null(self) -> None:
        ManifestSchema.from_manifest(_manifest()).validate(
            "chan_channels", {"name": "a", "notes": None}
        )

    def test_wrong_types(self) -> None:
        schema = ManifestSchema.from_manifest(_manifest())
        with pytest.raises(SchemaViolation, match="must be an integer"):
            schema.validate("chan_channels", {"name": "a", "size": "3"})
        with pytest.raises(SchemaViolation, match="must be a string"):
            schema.validate("chan_channels", {"name": 5})

    def test_unknown_column(self) -> None:
        with pytest.raises(SchemaViolation, match="unknown column"):
            ManifestSchema.from_manifest(_manifest()).validate(
                "chan_channels", {"name": "a", "bogus": 1}
            )

    def test_partial_skips_required_check(self) -> None:
        ManifestSchema.from_manifest(_manifest()).validate(
            "chan_channels", {"notes": "x"}, partial=True
        )

    def test_table_for_route(self) -> None:
        m = _manifest()
        assert ManifestSchema.from_manifest(m).table_for_route(m, "channels") == "chan_channels"
        assert ManifestSchema.from_manifest(m).table_for_route(m, "nope") is None


class TestFixtureRecorder:
    def test_replay_does_not_call_fetch(self, tmp_path: Path) -> None:
        FixtureRecorder(tmp_path, record=True).save("shape", {"a": 1})
        rec = FixtureRecorder(tmp_path, record=False)

        def boom() -> dict:
            raise AssertionError("fetch must not run in replay mode")

        assert rec.capture("shape", boom) == {"a": 1}

    def test_record_mode_calls_fetch_and_persists(self, tmp_path: Path) -> None:
        rec = FixtureRecorder(tmp_path, record=True)
        assert rec.capture("shape", lambda: {"b": 2}) == {"b": 2}
        assert FixtureRecorder(tmp_path, record=False).load("shape") == {"b": 2}

    def test_missing_fixture_fails_loudly_instead_of_inventing(self, tmp_path: Path) -> None:
        with pytest.raises(FixtureNotRecordedError):
            FixtureRecorder(tmp_path, record=False).load("absent")

    def test_env_var_enables_record(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("BIFFO_RECORD_FIXTURES", "1")
        assert FixtureRecorder(tmp_path).record is True
        monkeypatch.delenv("BIFFO_RECORD_FIXTURES")
        assert FixtureRecorder(tmp_path).record is False

    def test_rejects_path_traversal_shape(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError):
            FixtureRecorder(tmp_path).path_for("../x")
