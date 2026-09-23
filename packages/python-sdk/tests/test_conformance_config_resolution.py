"""`biffo_plugin_sdk.conformance.config_resolution` (biffo-template#1523 seam 4, #2086, #2096).

#1517 landed `PluginManifest.config` and `biffo_plugin_sdk.config`'s resolution
mechanism. The check has two halves and this file pins both:

1. **The plugin under verification's OWN declarations** (`ctx.repo_root`'s
   `biffo.plugin.json`): a `required: true` need with no value supplied fails
   the check, naming the key -- #2086's done-when 1, and #2096's defect 2.
2. **A disposable fixture covering both kinds** (`secret` and `setting`), so a
   regression in the SDK's own resolution code goes red on this check no matter
   what the plugin under verification happens to declare -- #2096's defect 1.

**The fail-first mutants are derived from the real source, not hand-written
stand-ins.** `_mutate` takes the actual source text of a function in
`biffo_plugin_sdk.config`, replaces ONE exact fragment, and installs the result
in place of the real function -- so a mutant is precisely "the revert a
prosecutor would make with an editor". The replaced fragment is asserted to
occur exactly once; if `config.py` is refactored so the fragment moves, the test
fails loudly at that assertion rather than silently mutating nothing (a mutant
that changes nothing would "pass" by the check staying green, which is the
hollow-test shape this whole file exists to avoid). Every mutant runs against a
repo that declares NO config, proving the fixture alone catches it.
"""

from __future__ import annotations

import inspect
import json
import os
import textwrap
from pathlib import Path
from typing import Any

import pytest
from biffo_plugin_sdk import config as sdk_config
from biffo_plugin_sdk.conformance import ConformanceCheckError, ConformanceContext
from biffo_plugin_sdk.conformance.checks import config_resolution as mod


@pytest.fixture(autouse=True)
def _clean_plugin_env(monkeypatch: pytest.MonkeyPatch):
    """No `BIFFO_PLUGIN_*` variable from the invoking shell may leak into (or
    out of) a test: the check reads the real environment as its supply channel."""
    for name in [n for n in os.environ if n.startswith("BIFFO_PLUGIN_")]:
        monkeypatch.delenv(name)


def _plugin_repo(tmp_path: Path, config: list[dict[str, Any]] | None, name: str = "demo-plugin"):
    manifest: dict[str, Any] = {"name": name, "version": "0.1.0"}
    if config is not None:
        manifest["config"] = config
    (tmp_path / "biffo.plugin.json").write_text(json.dumps(manifest), encoding="utf-8")
    return tmp_path


def _need(name: str, kind: str, required: bool) -> dict[str, Any]:
    return {"name": name, "kind": kind, "required": required, "description": "test need"}


def _run(repo: Path) -> None:
    mod.run(ConformanceContext(repo_root=repo))


@pytest.fixture
def clean_repo(tmp_path: Path) -> Path:
    """A plugin declaring NO config -- so any red result is the fixture's."""
    return _plugin_repo(tmp_path, None)


# --------------------------------------------------------------------------
# (1) the plugin under verification's OWN declared needs (#2086 done-when 1)
# --------------------------------------------------------------------------


class TestOwnDeclaredNeeds:
    def test_a_plugin_declaring_no_config_passes_and_says_so(self, clean_repo, capsys):
        _run(clean_repo)
        out = capsys.readouterr().out
        assert "plugin 'demo-plugin' declares no config needs" in out

    def test_required_secret_with_no_value_fails_naming_the_key(self, tmp_path):
        repo = _plugin_repo(tmp_path, [_need("my_key", "secret", True)])
        with pytest.raises(ConformanceCheckError) as excinfo:
            _run(repo)
        message = str(excinfo.value)
        assert "'my_key'" in message
        assert "BIFFO_PLUGIN_DEMO_PLUGIN_MY_KEY_PARAMETER" in message  # says how to supply it

    def test_required_setting_with_no_value_fails_naming_the_key(self, tmp_path):
        repo = _plugin_repo(tmp_path, [_need("my_group", "setting", True)])
        with pytest.raises(ConformanceCheckError) as excinfo:
            _run(repo)
        assert "'my_group'" in str(excinfo.value)
        assert "BIFFO_PLUGIN_DEMO_PLUGIN_MY_GROUP" in str(excinfo.value)

    def test_every_missing_required_need_is_named_not_just_the_first(self, tmp_path):
        repo = _plugin_repo(
            tmp_path,
            [
                _need("first_key", "secret", True),
                _need("second_key", "setting", True),
                _need("fine_key", "secret", False),
            ],
        )
        with pytest.raises(ConformanceCheckError) as excinfo:
            _run(repo)
        message = str(excinfo.value)
        assert "'first_key'" in message
        assert "'second_key'" in message
        assert "'fine_key'" not in message

    def test_required_needs_with_supplied_values_pass(self, tmp_path, monkeypatch, capsys):
        repo = _plugin_repo(
            tmp_path,
            [_need("my_key", "secret", True), _need("my_group", "setting", True)],
        )
        monkeypatch.setenv("BIFFO_PLUGIN_DEMO_PLUGIN_MY_KEY_PARAMETER", "/inst/demo/my_key")
        monkeypatch.setenv("BIFFO_PLUGIN_DEMO_PLUGIN_MY_GROUP", "literal-group-value")
        _run(repo)
        out = capsys.readouterr().out
        assert "2 config need(s)" in out
        assert "literal-group-value" not in out  # a resolved value is never printed

    def test_optional_needs_with_no_value_pass(self, tmp_path):
        repo = _plugin_repo(
            tmp_path, [_need("opt_key", "secret", False), _need("opt_group", "setting", False)]
        )
        _run(repo)

    def test_a_repo_with_no_manifest_fails_rather_than_passing_vacuously(self, tmp_path):
        with pytest.raises(ConformanceCheckError, match="no biffo.plugin.json"):
            _run(tmp_path)

    def test_a_manifest_the_real_schema_rejects_fails_naming_why(self, tmp_path):
        """#2096's aside: an upper-case need name is rejected by the manifest
        schema. That is a genuine defect in the plugin under verification and
        must fail here too (as it does in `host_mount`), naming the file --
        distinct from the FIXTURE being invalid (`TestFixtureIntegrity`)."""
        repo = _plugin_repo(tmp_path, [_need("MY_KEY", "secret", True)])
        with pytest.raises(ConformanceCheckError, match=r"biffo\.plugin\.json failed to validate"):
            _run(repo)

    def test_the_plugin_identity_binding_does_not_leak_out_of_the_check(self, clean_repo):
        from biffo_plugin_sdk.signed_client import acting_as_plugin

        before = acting_as_plugin.get()
        _run(clean_repo)
        assert acting_as_plugin.get() == before


class TestOwnNeedsCaughtEvenIfTheSdkFailsOpen:
    """If `get_plugin_config` stopped failing closed, a plugin's unsupplied
    required need would resolve to `None` -- the check must still fail on that
    plugin, independently of the fixture half."""

    def test_required_need_resolving_to_none_is_a_failure_for_the_plugins_own_need(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(mod, "get_plugin_config", lambda *a, **k: None)
        repo = _plugin_repo(tmp_path, [_need("my_key", "secret", True)])
        with pytest.raises(ConformanceCheckError) as excinfo:
            mod._check_plugin_own_needs(mod.load_manifest(repo / "biffo.plugin.json"))
        assert "'my_key'" in str(excinfo.value)


# --------------------------------------------------------------------------
# (2) the disposable fixture, both kinds -- green against the real, unmodified SDK
# --------------------------------------------------------------------------


class TestFixtureBaseline:
    def test_passes_against_the_real_unmodified_sdk(self, clean_repo, capsys):
        _run(clean_repo)
        out = capsys.readouterr().out
        for line in (
            "required secret need with no value fails closed, naming the key",
            "required setting need with no value fails closed, naming the key",
            "optional needs (secret and setting) with no value still install",
            "supplied needs (secret and setting) resolve",
            "required need under permanently-denied SSM fails closed",
            "required need whose SSM value is empty fails closed",
            "all three SSM-backed cache states exercised",
        ):
            assert line in out, line

    def test_leaves_no_env_vars_behind(self, clean_repo):
        _run(clean_repo)
        assert [n for n in os.environ if n.startswith("BIFFO_PLUGIN_")] == []


# --------------------------------------------------------------------------
# (3) fail-first: each revert goes red on config_resolution, from real source
# --------------------------------------------------------------------------


def _mutate(monkeypatch: pytest.MonkeyPatch, func_name: str, old: str, new: str) -> None:
    """Replace ONE fragment of the real `biffo_plugin_sdk.config.<func_name>`
    source and install the mutant in the SDK module (and in the check's own
    imported name, when it holds one)."""
    real = getattr(sdk_config, func_name)
    source = textwrap.dedent(inspect.getsource(real))
    assert source.count(old) == 1, (
        f"mutation target {old!r} occurs {source.count(old)}x in {func_name} -- config.py "
        "changed shape; update this mutant so it still reverts the intended path"
    )
    namespace = dict(vars(sdk_config))  # real classes/enums, so isinstance/`is` still hold
    exec(compile(source.replace(old, new), f"<mutant {func_name}>", "exec"), namespace)  # noqa: S102
    mutant = namespace[func_name]
    monkeypatch.setattr(sdk_config, func_name, mutant)
    if hasattr(mod, func_name):
        monkeypatch.setattr(mod, func_name, mutant)


class TestFailFirstRevertsOfTheSdksOwnCode:
    """#2086 done-when 1 / #2096 defect 1: reverting each path goes red on THIS
    check, against a plugin that declares nothing."""

    def test_secret_required_fail_closed_reverted(self, monkeypatch, clean_repo):
        _mutate(
            monkeypatch,
            "get_plugin_config",
            "            if required:\n",
            "            if False:\n",
        )
        with pytest.raises(ConformanceCheckError, match="required secret need.*failing closed"):
            _run(clean_repo)

    def test_setting_required_fail_closed_reverted(self, monkeypatch, clean_repo):
        """The prosecution's mutation M5: `if value is None and required:` ->
        `if value is None and False:` left the previous check green."""
        _mutate(
            monkeypatch,
            "get_plugin_config",
            "if value is None and required:",
            "if value is None and False:",
        )
        with pytest.raises(ConformanceCheckError, match="required setting need.*failing closed"):
            _run(clean_repo)

    def test_required_need_under_denied_tolerated(self, monkeypatch, clean_repo):
        """M4: a required need whose SSM access is DENIED must not be tolerated."""
        _mutate(
            monkeypatch,
            "get_plugin_config",
            "if resolution.state != ConfigState.RESOLVED:",
            "if resolution.state not in (ConfigState.RESOLVED, ConfigState.DENIED):",
        )
        with pytest.raises(ConformanceCheckError, match="permanently-denied"):
            _run(clean_repo)

    def test_empty_ssm_value_treated_as_resolved(self, monkeypatch, clean_repo):
        """M7: an SSM parameter holding an empty string is 'not configured'."""
        _mutate(monkeypatch, "resolve_secret", "    if not value:", "    if False:")
        with pytest.raises(ConformanceCheckError, match="empty"):
            _run(clean_repo)

    def test_throttling_cached_as_absent(self, monkeypatch, clean_repo):
        """marketing#25: a transient failure classified as a cacheable state."""
        _mutate(
            monkeypatch, "_classify_ssm_error", "    return None", "    return ConfigState.ABSENT"
        )
        with pytest.raises(ConformanceCheckError, match="transient"):
            _run(clean_repo)

    def test_denied_classified_as_absent(self, monkeypatch, clean_repo):
        _mutate(
            monkeypatch,
            "_classify_ssm_error",
            "return ConfigState.DENIED",
            "return ConfigState.ABSENT",
        )
        with pytest.raises(ConformanceCheckError, match="expected 'denied'"):
            _run(clean_repo)

    def test_absent_classified_as_denied(self, monkeypatch, clean_repo):
        _mutate(
            monkeypatch,
            "_classify_ssm_error",
            "return ConfigState.ABSENT",
            "return ConfigState.DENIED",
        )
        with pytest.raises(ConformanceCheckError, match="expected 'absent'"):
            _run(clean_repo)

    def test_optional_secret_wrongly_made_mandatory(self, monkeypatch, clean_repo):
        _mutate(
            monkeypatch, "get_plugin_config", "            if required:\n", "            if True:\n"
        )
        with pytest.raises(ConformanceCheckError, match="optional"):
            _run(clean_repo)

    def test_optional_setting_wrongly_made_mandatory(self, monkeypatch, clean_repo):
        _mutate(
            monkeypatch,
            "get_plugin_config",
            "if value is None and required:",
            "if value is None:",
        )
        with pytest.raises(ConformanceCheckError, match="optional"):
            _run(clean_repo)

    def test_supplied_setting_dropped(self, monkeypatch, clean_repo):
        """A resolver that always raises/returns nothing must not pass as 'fail closed'."""
        _mutate(monkeypatch, "get_plugin_config", "        return value\n", "        return None\n")
        with pytest.raises(ConformanceCheckError, match="supplied"):
            _run(clean_repo)

    def test_transient_error_swallowed_for_an_optional_need(self, monkeypatch, clean_repo):
        """Transient must propagate through `get_plugin_config` too, required or
        not -- a resolver that turns it into `None` for an optional need would
        cache 'unconfigured' for a working feature (marketing#25)."""
        real = sdk_config.resolve_secret

        def _swallowing(plugin_name, config_name, *, ssm_client=None):
            try:
                return real(plugin_name, config_name, ssm_client=ssm_client)
            except sdk_config.PluginConfigTransientError:
                return sdk_config.SecretResolution(state=sdk_config.ConfigState.ABSENT)

        monkeypatch.setattr(sdk_config, "resolve_secret", _swallowing)
        monkeypatch.setattr(mod, "resolve_secret", _swallowing)
        with pytest.raises(ConformanceCheckError, match="transient"):
            _run(clean_repo)


class TestFixtureAssertionsNotReachableThroughSourceMutants:
    """Assertions whose failure needs a second, independent lie (the check
    asserts the same fact at two levels), pinned by patching the check's own
    imported names."""

    def test_optional_need_returning_a_value_instead_of_none(self, monkeypatch, clean_repo):
        real = mod.get_plugin_config

        def _optional_invents_a_value(name, *, kind, required=True, ssm_client=None):
            return real(name, kind=kind, required=required, ssm_client=ssm_client) or (
                None if required else "invented"
            )

        monkeypatch.setattr(mod, "get_plugin_config", _optional_invents_a_value)
        with pytest.raises(ConformanceCheckError, match="returned a value instead of None"):
            _run(clean_repo)

    def test_supplied_secret_dropped(self, monkeypatch, clean_repo):
        _mutate(
            monkeypatch,
            "get_plugin_config",
            "        return resolution.value",
            "        return None",
        )
        with pytest.raises(ConformanceCheckError, match="supplied secret need"):
            _run(clean_repo)

    def test_resolve_secret_misclassifying_denied_directly(self, monkeypatch, clean_repo):
        """`resolve_secret` (called directly by the check) reporting DENIED as
        ABSENT, while `get_plugin_config` -- which the other assertions go
        through -- is untouched."""
        real = mod.resolve_secret

        def _denied_becomes_absent(plugin_name, config_name, *, ssm_client=None):
            result = real(plugin_name, config_name, ssm_client=ssm_client)
            if result.state is sdk_config.ConfigState.DENIED:
                return sdk_config.SecretResolution(state=sdk_config.ConfigState.ABSENT)
            return result

        monkeypatch.setattr(mod, "resolve_secret", _denied_becomes_absent)
        with pytest.raises(ConformanceCheckError, match="expected 'denied'"):
            _run(clean_repo)

    def test_a_preexisting_fixture_variable_is_restored_not_clobbered(
        self, monkeypatch, clean_repo
    ):
        name = "BIFFO_PLUGIN_CONFORMANCE_CONFIG_FIXTURE_REQUIRED_NEED_PARAMETER"
        monkeypatch.setenv(name, "/operator/set/this")
        _run(clean_repo)
        assert os.environ[name] == "/operator/set/this"


class TestErrorNamingIsAsserted:
    def test_a_fail_closed_error_that_does_not_name_the_key_is_caught(
        self, monkeypatch, clean_repo
    ):
        def _nameless(name, *, kind, required=True, ssm_client=None):
            raise sdk_config.PluginConfigError(
                "<redacted>", sdk_config.ConfigState.ABSENT, "no value supplied"
            )

        monkeypatch.setattr(mod, "get_plugin_config", _nameless)
        with pytest.raises(ConformanceCheckError, match="did not name the missing key"):
            _run(clean_repo)

    def test_a_fail_closed_error_with_the_wrong_state_is_caught(self, monkeypatch, clean_repo):
        real = mod.get_plugin_config

        def _every_failure_reported_absent(name, *, kind, required=True, ssm_client=None):
            try:
                return real(name, kind=kind, required=required, ssm_client=ssm_client)
            except sdk_config.PluginConfigError as exc:
                # A DENIED failure misreported as ABSENT (operator told "not configured").
                raise sdk_config.PluginConfigError(
                    name, sdk_config.ConfigState.ABSENT, "x"
                ) from exc

        monkeypatch.setattr(mod, "get_plugin_config", _every_failure_reported_absent)
        with pytest.raises(ConformanceCheckError, match="reported state"):
            _run(clean_repo)


# --------------------------------------------------------------------------
# (4) the fixture's own integrity
# --------------------------------------------------------------------------


class TestFixtureIntegrity:
    def test_fixture_declares_both_kinds_required_and_optional(self):
        declared = {(d["kind"], d["required"]) for d in mod._FIXTURE_MANIFEST["config"]}
        assert declared == {
            ("secret", True),
            ("secret", False),
            ("setting", True),
            ("setting", False),
        }

    def test_a_fixture_manifest_the_real_schema_rejects_fails_the_check_naming_why(
        self, monkeypatch, clean_repo
    ):
        broken = {
            **mod._FIXTURE_MANIFEST,
            "config": [{"name": "x", "kind": "not-a-real-kind", "required": True}],
        }
        monkeypatch.setattr(mod, "_FIXTURE_MANIFEST", broken)
        with pytest.raises(
            ConformanceCheckError, match="fixture manifest at .* failed to validate"
        ) as excinfo:
            _run(clean_repo)
        assert isinstance(excinfo.value.__cause__, ValueError)
        assert "Schema validation failed" in str(excinfo.value)

    def test_a_fixture_manifest_that_was_never_written_fails_the_check_naming_why(
        self, monkeypatch, clean_repo
    ):
        monkeypatch.setattr(
            mod, "_write_fixture_manifest", lambda directory: directory / "absent.json"
        )
        with pytest.raises(
            ConformanceCheckError, match="fixture manifest at .* failed to validate"
        ) as excinfo:
            _run(clean_repo)
        assert isinstance(excinfo.value.__cause__, FileNotFoundError)

    def test_a_fixture_that_lost_a_declaration_in_the_round_trip_is_caught(
        self, monkeypatch, clean_repo
    ):
        trimmed = {**mod._FIXTURE_MANIFEST, "config": mod._FIXTURE_MANIFEST["config"][:1]}
        monkeypatch.setattr(mod, "_FIXTURE_MANIFEST", trimmed)
        with pytest.raises(ConformanceCheckError, match="did not round-trip"):
            _run(clean_repo)
