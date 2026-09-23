"""`biffo_plugin_sdk.conformance.checks.cdn_public_routes` (biffo-template#1523
seam 5, #2087).

Mirrors `test_conformance_host_mount.py`'s fixture pattern: a synthetic
`tmp_path` stands in for a plugin repo's own root (`ctx.repo_root`), with a
real `biffo.plugin.json` written to it and, where a case needs one, a real
`modules/cloud/aws/cdn/path-contract.json` alongside it.

Covers #2087's own done-when directly:

- a route carrying `cdn_contract_key` with NO matching `path-contract.json`
  row FAILS, naming the plugin, the route and the missing key (fail-first:
  before this check existed, `cdn_contract_key` was silently dropped by
  `RouteDef` and nothing enforced it at all -- see `test_plugin.py`'s
  `TestRouteDef` for the field itself);
- a route correctly present in both the manifest (via `cdn_contract_key`) and
  `path-contract.json` PASSES;
- a manifest with zero `cdn_contract_key` routes passes regardless of whether
  `path-contract.json` exists at all -- most real plugin repos have no
  Terraform and never will (this check's own module docstring).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from biffo_plugin_sdk.conformance import ConformanceCheckError, ConformanceContext
from biffo_plugin_sdk.conformance.checks import cdn_public_routes


def _write_manifest(repo_root: Path, manifest: dict) -> None:
    (repo_root / "biffo.plugin.json").write_text(json.dumps(manifest), encoding="utf-8")


def _write_contract(repo_root: Path, rows: list[dict]) -> None:
    contract_dir = repo_root / "modules" / "cloud" / "aws" / "cdn"
    contract_dir.mkdir(parents=True, exist_ok=True)
    (contract_dir / "path-contract.json").write_text(json.dumps({"rows": rows}), encoding="utf-8")


def _base_manifest(**overrides) -> dict:
    manifest = {
        "name": "fixture_plugin",
        "version": "0.1.0",
        "tables": [{"name": "widgets"}],
    }
    manifest.update(overrides)
    return manifest


_CLICK_ROW = {
    "key": "click",
    "path_pattern": "c/*",
    "origin": "core-api",
    "origin_path_prefix": "/api/v1/public",
    "token_required": True,
    "function": "click-rewrite",
}


class TestCdnPublicRoutesSuccess:
    def test_a_route_with_no_cdn_contract_key_is_unaffected(self, tmp_path):
        """#2087's own additive requirement: existing manifests with no
        CDN-contract route are unaffected -- no path-contract.json needed at
        all."""
        _write_manifest(
            tmp_path,
            _base_manifest(
                api_routes=[
                    {"method": "GET", "path": "/widgets", "table": "widgets", "operation": "list"}
                ]
            ),
        )
        cdn_public_routes.run(ConformanceContext(repo_root=tmp_path))

    def test_zero_routes_passes_even_with_no_contract_file_present(self, tmp_path):
        _write_manifest(tmp_path, _base_manifest())
        cdn_public_routes.run(ConformanceContext(repo_root=tmp_path))

    def test_a_route_correctly_present_in_both_manifest_and_contract_passes(self, tmp_path):
        _write_manifest(
            tmp_path,
            _base_manifest(
                api_routes=[
                    {
                        "method": "GET",
                        "path": "/widgets",
                        "table": "widgets",
                        "operation": "list",
                        "cdn_contract_key": "click",
                    }
                ]
            ),
        )
        _write_contract(tmp_path, [_CLICK_ROW])

        cdn_public_routes.run(ConformanceContext(repo_root=tmp_path))

    def test_prints_the_denominator_before_the_verdict(self, tmp_path, capsys):
        """#1363's shape: a green run must print what it checked, not just
        that it passed."""
        _write_manifest(
            tmp_path,
            _base_manifest(
                api_routes=[
                    {
                        "method": "GET",
                        "path": "/widgets",
                        "table": "widgets",
                        "operation": "list",
                        "cdn_contract_key": "click",
                    }
                ]
            ),
        )
        _write_contract(tmp_path, [_CLICK_ROW])

        cdn_public_routes.run(ConformanceContext(repo_root=tmp_path))

        out = capsys.readouterr().out
        assert "1 declared route(s) carry a cdn_contract_key" in out
        assert "1/1 declared route(s) resolved against" in out


class TestCdnPublicRoutesFailures:
    def test_missing_manifest_names_the_path(self, tmp_path):
        with pytest.raises(ConformanceCheckError, match="no biffo.plugin.json at"):
            cdn_public_routes.run(ConformanceContext(repo_root=tmp_path))

    def test_invalid_manifest_json_is_reported_not_raised_raw(self, tmp_path):
        (tmp_path / "biffo.plugin.json").write_text("{not valid json", encoding="utf-8")
        with pytest.raises(ConformanceCheckError, match="failed to validate"):
            cdn_public_routes.run(ConformanceContext(repo_root=tmp_path))

    def test_cdn_contract_key_with_no_contract_file_at_all_fails_naming_the_route(self, tmp_path):
        """Fail-first case #1 from #2087's done-when: a fresh scaffolded
        plugin (no Terraform, so no path-contract.json at all) declaring a
        route against a CDN-contract key that cannot possibly resolve."""
        _write_manifest(
            tmp_path,
            _base_manifest(
                api_routes=[
                    {
                        "method": "GET",
                        "path": "/widgets",
                        "table": "widgets",
                        "operation": "list",
                        "cdn_contract_key": "does-not-exist",
                    }
                ]
            ),
        )

        with pytest.raises(ConformanceCheckError) as exc_info:
            cdn_public_routes.run(ConformanceContext(repo_root=tmp_path))

        message = str(exc_info.value)
        assert "fixture_plugin" in message
        assert "GET /widgets" in message
        assert "does-not-exist" in message

    def test_cdn_contract_key_with_a_contract_file_missing_the_row_fails_naming_the_route(
        self, tmp_path
    ):
        """Fail-first case #2: a path-contract.json exists (other rows are
        declared) but none matches this route's key."""
        _write_manifest(
            tmp_path,
            _base_manifest(
                api_routes=[
                    {
                        "method": "GET",
                        "path": "/widgets",
                        "table": "widgets",
                        "operation": "list",
                        "cdn_contract_key": "does-not-exist",
                    }
                ]
            ),
        )
        _write_contract(tmp_path, [_CLICK_ROW])

        with pytest.raises(ConformanceCheckError) as exc_info:
            cdn_public_routes.run(ConformanceContext(repo_root=tmp_path))

        message = str(exc_info.value)
        assert "fixture_plugin" in message
        assert "GET /widgets" in message
        assert "does-not-exist" in message
        assert "click" in message  # the known keys are named too, for a fast diagnosis

    def test_only_the_failing_routes_are_named_when_others_resolve(self, tmp_path):
        _write_manifest(
            tmp_path,
            _base_manifest(
                tables=[{"name": "widgets"}, {"name": "gizmos"}],
                api_routes=[
                    {
                        "method": "GET",
                        "path": "/widgets",
                        "table": "widgets",
                        "operation": "list",
                        "cdn_contract_key": "click",
                    },
                    {
                        "method": "GET",
                        "path": "/gizmos",
                        "table": "gizmos",
                        "operation": "list",
                        "cdn_contract_key": "does-not-exist",
                    },
                ],
            ),
        )
        _write_contract(tmp_path, [_CLICK_ROW])

        with pytest.raises(ConformanceCheckError) as exc_info:
            cdn_public_routes.run(ConformanceContext(repo_root=tmp_path))

        message = str(exc_info.value)
        assert "1/2 route(s)" in message
        assert "GET /gizmos" in message
        assert "GET /widgets" not in message

    def test_malformed_contract_json_is_reported_not_raised_raw(self, tmp_path):
        _write_manifest(
            tmp_path,
            _base_manifest(
                api_routes=[
                    {
                        "method": "GET",
                        "path": "/widgets",
                        "table": "widgets",
                        "operation": "list",
                        "cdn_contract_key": "click",
                    }
                ]
            ),
        )
        contract_dir = tmp_path / "modules" / "cloud" / "aws" / "cdn"
        contract_dir.mkdir(parents=True)
        (contract_dir / "path-contract.json").write_text("{not valid json", encoding="utf-8")

        with pytest.raises(ConformanceCheckError, match="not valid JSON"):
            cdn_public_routes.run(ConformanceContext(repo_root=tmp_path))
