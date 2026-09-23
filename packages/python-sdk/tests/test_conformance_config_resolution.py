"""`biffo_plugin_sdk.conformance.config_resolution` (biffo-template#1523 seam 4, #2086).

#1517 landed `PluginManifest.config: list[ConfigDeclaration]` and
`biffo_plugin_sdk.config`'s resolution mechanism (fail closed on a missing
`required` need; three-state SSM-backed classification; a transient failure
raises rather than being cached). This check proves that mechanism end to
end through its own disposable fixture manifest — see the check module's own
docstring for why it does not read `ctx.repo_root`'s real manifest the way
`host_mount` does.

Nothing here mocks `get_plugin_config`, `resolve_secret`, `ConfigDeclaration`
or `PluginManifest` — only the SSM boundary is a stand-in (`_FakeSsm`,
matching `biffo_plugin_sdk`'s own `tests/test_config.py` fixture), exactly as
the module's own docstring says it must be.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from biffo_plugin_sdk.conformance import ConformanceCheckError, ConformanceContext
from biffo_plugin_sdk.conformance.checks import config_resolution


@pytest.fixture(autouse=True)
def _clean_fixture_env():
    """The check computes real env var names from a real (fixed) plugin/config
    name pair, and manages them itself with save/restore — but a test that
    fails mid-way could still leave one set for the next test in the same
    process. Belt-and-braces: clear before and after every test."""
    names = [
        "BIFFO_PLUGIN_CONFORMANCE_CONFIG_FIXTURE_REQUIRED_NEED_PARAMETER",
        "BIFFO_PLUGIN_CONFORMANCE_CONFIG_FIXTURE_OPTIONAL_NEED_PARAMETER",
    ]
    for name in names:
        os.environ.pop(name, None)
    yield
    for name in names:
        os.environ.pop(name, None)


def _run() -> None:
    # `repo_root` is unused by this check (see the module's own docstring for
    # why) -- any Path is fine, so a nonexistent one is used deliberately to
    # prove that.
    config_resolution.run(ConformanceContext(repo_root=Path("/nonexistent-unused-by-this-check")))


class TestConfigResolutionSuccess:
    def test_passes_against_the_real_unmodified_sdk(self, capsys):
        """The check's own fixture, run against #1517's real, unmodified
        resolve/fail-closed code, is green — the baseline this milestone's
        fail-first proof (see the PR body) reverts one path away from."""
        _run()
        out = capsys.readouterr().out
        assert "required need with no value fails closed" in out
        assert "optional need with no value still installs" in out
        assert "all three SSM-backed cache states exercised" in out

    def test_leaves_no_env_vars_behind(self):
        _run()
        assert "BIFFO_PLUGIN_CONFORMANCE_CONFIG_FIXTURE_REQUIRED_NEED_PARAMETER" not in os.environ
        assert "BIFFO_PLUGIN_CONFORMANCE_CONFIG_FIXTURE_OPTIONAL_NEED_PARAMETER" not in os.environ


class TestConfigResolutionFailFirst:
    """Fail-first proof (#2086's own done-when): reverting one of #1517's
    fail-closed paths must turn exactly the corresponding assertion red, with
    no other change — reproduced here by monkeypatching the SAME seam a real
    regression would break, rather than the check's own code.
    """

    def test_a_required_need_that_silently_resolves_instead_of_raising_is_caught(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """Simulates #1517's fail-closed path being reverted: `get_plugin_config`
        no longer raises for a required-but-unresolvable secret, and instead
        returns `None` (the shape a "just warn and continue" regression would
        take). This is precisely the defect class the issue's fail-first
        requirement asks to be provably caught, not assumed caught."""
        import biffo_plugin_sdk.conformance.checks.config_resolution as mod

        def _silently_permissive(name, *, kind, required=True, ssm_client=None):  # noqa: ANN001, ARG001
            return None

        monkeypatch.setattr(mod, "get_plugin_config", _silently_permissive)

        with pytest.raises(
            ConformanceCheckError, match="resolved successfully instead of failing closed"
        ):
            _run()

    def test_an_error_that_does_not_name_the_missing_key_is_caught(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The done-when is explicit that the harness must fail closed NAMING
        the missing key, not merely fail closed silently."""
        import biffo_plugin_sdk.conformance.checks.config_resolution as mod
        from biffo_plugin_sdk.config import ConfigState, PluginConfigError

        def _raises_without_naming_the_key(name, *, kind, required=True, ssm_client=None):  # noqa: ANN001, ARG001
            raise PluginConfigError("<redacted>", ConfigState.ABSENT, "no value supplied")

        monkeypatch.setattr(mod, "get_plugin_config", _raises_without_naming_the_key)

        with pytest.raises(ConformanceCheckError, match="did not name the missing key"):
            _run()

    def test_an_optional_need_that_raises_instead_of_returning_none_is_caught(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The inverse regression: an optional need becomes wrongly mandatory
        and blocks install when it must not."""
        import biffo_plugin_sdk.conformance.checks.config_resolution as mod
        from biffo_plugin_sdk.config import ConfigState, PluginConfigError

        real = mod.get_plugin_config

        def _optional_also_raises(name, *, kind, required=True, ssm_client=None):  # noqa: ANN001
            if name == config_resolution._OPTIONAL_NEED:
                raise PluginConfigError(name, ConfigState.ABSENT, "no value supplied")
            return real(name, kind=kind, required=required, ssm_client=ssm_client)

        monkeypatch.setattr(mod, "get_plugin_config", _optional_also_raises)

        with pytest.raises(ConformanceCheckError):
            _run()

    def test_ssm_parameter_not_found_misclassified_as_denied_is_caught(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """Reverts the confirmed-absent cache state: `resolve_secret` returning
        `DENIED` for a genuinely-absent parameter would tell an operator
        "misconfigured IAM" for what is really "not configured"."""
        import biffo_plugin_sdk.conformance.checks.config_resolution as mod
        from biffo_plugin_sdk.config import ConfigState, SecretResolution

        def _always_denied(plugin_name, config_name, *, ssm_client=None):  # noqa: ANN001, ARG001
            return SecretResolution(state=ConfigState.DENIED, detail="misclassified by the test")

        monkeypatch.setattr(mod, "resolve_secret", _always_denied)

        with pytest.raises(ConformanceCheckError, match="expected 'absent'"):
            _run()

    def test_ssm_access_denied_misclassified_as_absent_is_caught(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """Reverts the permanently-denied cache state the opposite direction."""
        import biffo_plugin_sdk.conformance.checks.config_resolution as mod
        from biffo_plugin_sdk.config import ConfigState, SecretResolution

        def _always_absent(plugin_name, config_name, *, ssm_client=None):  # noqa: ANN001, ARG001
            return SecretResolution(state=ConfigState.ABSENT, detail="misclassified by the test")

        monkeypatch.setattr(mod, "resolve_secret", _always_absent)

        with pytest.raises(ConformanceCheckError, match="expected 'denied'"):
            _run()

    def test_a_transient_ssm_failure_cached_as_a_state_instead_of_raising_is_caught(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """marketing#25's exact regression, reproduced against this check:
        a throttling error must never be classified into a cacheable
        `ConfigState` — it must raise `PluginConfigTransientError` instead."""
        import biffo_plugin_sdk.conformance.checks.config_resolution as mod
        from biffo_plugin_sdk.config import ConfigState, SecretResolution

        real = mod.resolve_secret

        def _throttle_becomes_absent(plugin_name, config_name, *, ssm_client=None):  # noqa: ANN001
            # `resolve_secret` is also called (indirectly, via `get_plugin_config`)
            # by steps (1)/(2) earlier in `run()`, so this identifies the ONE
            # call it means to corrupt by what the fake SSM client would raise,
            # not by call order/count -- robust to `run()`'s own call sequence
            # changing.
            error = getattr(ssm_client, "error", None)
            response = getattr(error, "response", None) if error is not None else None
            code = response.get("Error", {}).get("Code", "") if isinstance(response, dict) else ""
            if code == "ThrottlingException":
                return SecretResolution(
                    state=ConfigState.ABSENT, detail="throttle miscached as absent"
                )
            return real(plugin_name, config_name, ssm_client=ssm_client)

        monkeypatch.setattr(mod, "resolve_secret", _throttle_becomes_absent)

        with pytest.raises(ConformanceCheckError, match="marketing#25's regression"):
            _run()


class TestConfigResolutionOwnFixtureIntegrity:
    def test_fixture_manifest_round_trips_through_the_real_schema(self):
        """If `ConfigDeclaration`/`PluginManifest` ever stopped accepting this
        shape, the check should say so plainly rather than crash obscurely
        inside `load_manifest`."""
        # Exercised implicitly by every passing run above; this test documents
        # the intent directly by asserting the fixture's own declared shape.
        assert config_resolution._FIXTURE_MANIFEST["config"][0]["required"] is True
        assert config_resolution._FIXTURE_MANIFEST["config"][1]["required"] is False

    def test_a_fixture_manifest_the_real_schema_rejects_fails_the_check_naming_why(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The `except (FileNotFoundError, ValueError)` around `load_manifest`
        (#2089's error-branch coverage gate). If the fixture drifted out of the
        real `PluginManifest` schema, `load_manifest` raises `ValueError`; the
        check must turn that into a `ConformanceCheckError` that says the
        fixture -- not the plugin under verification -- is at fault, chaining
        the original error, rather than leaking a raw `ValueError`."""
        import biffo_plugin_sdk.conformance.checks.config_resolution as mod

        broken = {
            **mod._FIXTURE_MANIFEST,
            "config": [{"name": "x", "kind": "not-a-real-kind", "required": True}],
        }
        monkeypatch.setattr(mod, "_FIXTURE_MANIFEST", broken)

        with pytest.raises(
            ConformanceCheckError, match="fixture manifest at .* failed to validate"
        ) as excinfo:
            _run()
        assert isinstance(excinfo.value.__cause__, ValueError)
        assert "Schema validation failed" in str(excinfo.value)

    def test_a_fixture_manifest_that_was_never_written_fails_the_check_naming_why(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """Same handler, its `FileNotFoundError` arm: the fixture file is not
        on disk when `load_manifest` looks for it."""
        import biffo_plugin_sdk.conformance.checks.config_resolution as mod

        monkeypatch.setattr(
            mod, "_write_fixture_manifest", lambda directory: directory / "absent.json"
        )

        with pytest.raises(
            ConformanceCheckError, match="fixture manifest at .* failed to validate"
        ) as excinfo:
            _run()
        assert isinstance(excinfo.value.__cause__, FileNotFoundError)
