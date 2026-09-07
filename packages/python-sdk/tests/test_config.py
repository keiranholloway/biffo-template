"""Tests for per-plugin config resolution (biffo-template#1517)."""

from __future__ import annotations

from typing import Any

import pytest
from biffo_plugin_sdk import (
    ConfigState,
    PluginConfigError,
    PluginConfigTransientError,
    get_plugin_config,
    plugin_config_env_names,
    resolve_secret,
    resolve_setting,
)
from biffo_plugin_sdk.signed_client import acting_as_plugin


class _FakeSsm:
    """A minimal SSM stand-in: `params` maps parameter name to value; `error`,
    when set, is raised (with a `.response` matching a real botocore
    ClientError's shape) on every `get_parameter` call instead of returning.
    """

    def __init__(self, params: dict[str, str] | None = None, error: Exception | None = None):
        self.params = params or {}
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def get_parameter(self, *, Name: str, WithDecryption: bool):  # noqa: N803 — mirrors botocore's own kwarg casing
        self.calls.append({"Name": Name, "WithDecryption": WithDecryption})
        if self.error is not None:
            raise self.error
        if Name not in self.params:
            raise _client_error("ParameterNotFound")
        return {"Parameter": {"Value": self.params[Name]}}


def _client_error(code: str) -> Exception:
    exc = Exception(f"simulated {code}")
    exc.response = {"Error": {"Code": code}}  # type: ignore[attr-defined]
    return exc


class TestPluginConfigEnvNames:
    def test_names_are_scoped_by_plugin_and_config_name(self):
        literal, parameter = plugin_config_env_names("marketing", "image_provider_api_key")
        assert literal == "BIFFO_PLUGIN_MARKETING_IMAGE_PROVIDER_API_KEY"
        assert parameter == "BIFFO_PLUGIN_MARKETING_IMAGE_PROVIDER_API_KEY_PARAMETER"

    def test_hyphenated_plugin_name_is_normalised(self):
        # Plugin names are kebab-case (PluginManifest.name); env vars can't
        # carry a hyphen, so it becomes an underscore rather than being
        # silently dropped (which would collide "idea-scout" and "ideascout").
        literal, _ = plugin_config_env_names("idea-scout", "api_key")
        assert literal == "BIFFO_PLUGIN_IDEA_SCOUT_API_KEY"

    def test_two_plugins_never_share_an_env_var_for_the_same_config_name(self):
        a, _ = plugin_config_env_names("marketing", "api_key")
        b, _ = plugin_config_env_names("idea-scout", "api_key")
        assert a != b


class TestResolveSetting:
    def test_reads_the_scoped_literal_env_var(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("BIFFO_PLUGIN_MARKETING_USER_INGRESS_GROUP", "unit-staff")
        assert resolve_setting("marketing", "user_ingress_group") == "unit-staff"

    def test_absent_returns_none(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.delenv("BIFFO_PLUGIN_MARKETING_USER_INGRESS_GROUP", raising=False)
        assert resolve_setting("marketing", "user_ingress_group") is None

    def test_blank_is_treated_as_absent(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("BIFFO_PLUGIN_MARKETING_USER_INGRESS_GROUP", "   ")
        assert resolve_setting("marketing", "user_ingress_group") is None

    def test_does_not_read_a_different_plugins_env_var(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("BIFFO_PLUGIN_IDEA_SCOUT_USER_INGRESS_GROUP", "founder")
        monkeypatch.delenv("BIFFO_PLUGIN_MARKETING_USER_INGRESS_GROUP", raising=False)
        assert resolve_setting("marketing", "user_ingress_group") is None


class TestResolveSecretThreeStateResolution:
    """marketing#25's lesson: absent/denied are cacheable states, a transient
    SSM failure is never one of them — it raises instead."""

    def test_no_parameter_env_var_set_is_absent(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.delenv("BIFFO_PLUGIN_MARKETING_API_KEY_PARAMETER", raising=False)
        result = resolve_secret("marketing", "api_key", ssm_client=_FakeSsm())
        assert result.state is ConfigState.ABSENT

    def test_parameter_not_found_in_ssm_is_absent(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv(
            "BIFFO_PLUGIN_MARKETING_API_KEY_PARAMETER", "/myproject/dev/marketing/api-key"
        )
        ssm = _FakeSsm(params={})  # the named parameter genuinely does not exist
        result = resolve_secret("marketing", "api_key", ssm_client=ssm)
        assert result.state is ConfigState.ABSENT
        assert ssm.calls == [{"Name": "/myproject/dev/marketing/api-key", "WithDecryption": True}]

    def test_access_denied_is_denied_not_absent(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv(
            "BIFFO_PLUGIN_MARKETING_API_KEY_PARAMETER", "/myproject/dev/marketing/api-key"
        )
        ssm = _FakeSsm(error=_client_error("AccessDeniedException"))
        result = resolve_secret("marketing", "api_key", ssm_client=ssm)
        assert result.state is ConfigState.DENIED

    def test_throttling_is_transient_and_raises_rather_than_returning_a_state(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The exact defect marketing#25 shipped: a transient SSM error must
        never be classified as ABSENT/DENIED — those are cacheable, and
        caching a throttle as "unconfigured" disables a working feature."""
        monkeypatch.setenv(
            "BIFFO_PLUGIN_MARKETING_API_KEY_PARAMETER", "/myproject/dev/marketing/api-key"
        )
        ssm = _FakeSsm(error=_client_error("ThrottlingException"))
        with pytest.raises(PluginConfigTransientError):
            resolve_secret("marketing", "api_key", ssm_client=ssm)

    def test_unclassified_exception_is_also_transient(self, monkeypatch: pytest.MonkeyPatch):
        """Anything not recognised as ParameterNotFound/AccessDenied — a bare
        connection error, a timeout with no `.response` at all — must default
        to transient, not to a cacheable state, since assuming "final" on an
        unknown failure shape is the same mistake with a different name."""
        monkeypatch.setenv(
            "BIFFO_PLUGIN_MARKETING_API_KEY_PARAMETER", "/myproject/dev/marketing/api-key"
        )
        ssm = _FakeSsm(error=TimeoutError("connect timed out"))
        with pytest.raises(PluginConfigTransientError):
            resolve_secret("marketing", "api_key", ssm_client=ssm)

    def test_empty_parameter_value_is_absent(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv(
            "BIFFO_PLUGIN_MARKETING_API_KEY_PARAMETER", "/myproject/dev/marketing/api-key"
        )
        ssm = _FakeSsm(params={"/myproject/dev/marketing/api-key": "   "})
        result = resolve_secret("marketing", "api_key", ssm_client=ssm)
        assert result.state is ConfigState.ABSENT

    def test_resolved_value_is_returned_and_decryption_requested(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv(
            "BIFFO_PLUGIN_MARKETING_API_KEY_PARAMETER", "/myproject/dev/marketing/api-key"
        )
        ssm = _FakeSsm(params={"/myproject/dev/marketing/api-key": "sk-real-key"})
        result = resolve_secret("marketing", "api_key", ssm_client=ssm)
        assert result.state is ConfigState.RESOLVED
        assert result.value == "sk-real-key"
        assert ssm.calls[0]["WithDecryption"] is True


class TestGetPluginConfigScoping:
    """`get_plugin_config` is scoped to `acting_as_plugin` — the identity the
    shared host's `group_gate` binds per request — so a plugin has no
    parameter through which to name a different plugin's config."""

    def test_raises_when_no_plugin_identity_is_bound(self):
        assert acting_as_plugin.get() is None
        with pytest.raises(PluginConfigError):
            get_plugin_config("api_key", kind="secret")

    def test_reads_the_bound_plugins_own_setting(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("BIFFO_PLUGIN_MARKETING_GROUP", "unit-staff")
        reset = acting_as_plugin.set("marketing")
        try:
            assert get_plugin_config("group", kind="setting") == "unit-staff"
        finally:
            acting_as_plugin.reset(reset)

    def test_does_not_read_a_different_plugins_setting_even_though_it_exists(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("BIFFO_PLUGIN_IDEA_SCOUT_GROUP", "founder")
        monkeypatch.delenv("BIFFO_PLUGIN_MARKETING_GROUP", raising=False)
        reset = acting_as_plugin.set("marketing")
        try:
            with pytest.raises(PluginConfigError):
                get_plugin_config("group", kind="setting", required=True)
        finally:
            acting_as_plugin.reset(reset)

    def test_required_secret_missing_raises(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.delenv("BIFFO_PLUGIN_MARKETING_API_KEY_PARAMETER", raising=False)
        reset = acting_as_plugin.set("marketing")
        try:
            with pytest.raises(PluginConfigError) as exc_info:
                get_plugin_config("api_key", kind="secret", ssm_client=_FakeSsm())
            assert exc_info.value.state is ConfigState.ABSENT
        finally:
            acting_as_plugin.reset(reset)

    def test_optional_secret_missing_returns_none(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.delenv("BIFFO_PLUGIN_MARKETING_API_KEY_PARAMETER", raising=False)
        reset = acting_as_plugin.set("marketing")
        try:
            assert (
                get_plugin_config("api_key", kind="secret", required=False, ssm_client=_FakeSsm())
                is None
            )
        finally:
            acting_as_plugin.reset(reset)

    def test_resolved_secret_is_returned(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv(
            "BIFFO_PLUGIN_MARKETING_API_KEY_PARAMETER", "/myproject/dev/marketing/api-key"
        )
        ssm = _FakeSsm(params={"/myproject/dev/marketing/api-key": "sk-real-key"})
        reset = acting_as_plugin.set("marketing")
        try:
            assert get_plugin_config("api_key", kind="secret", ssm_client=ssm) == "sk-real-key"
        finally:
            acting_as_plugin.reset(reset)

    def test_transient_secret_failure_propagates_rather_than_resolving(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv(
            "BIFFO_PLUGIN_MARKETING_API_KEY_PARAMETER", "/myproject/dev/marketing/api-key"
        )
        ssm = _FakeSsm(error=_client_error("ThrottlingException"))
        reset = acting_as_plugin.set("marketing")
        try:
            with pytest.raises(PluginConfigTransientError):
                get_plugin_config("api_key", kind="secret", ssm_client=ssm)
        finally:
            acting_as_plugin.reset(reset)

    def test_unknown_kind_raises_value_error(self):
        reset = acting_as_plugin.set("marketing")
        try:
            with pytest.raises(ValueError, match="unknown config kind"):
                get_plugin_config("x", kind="credential")  # type: ignore[arg-type]
        finally:
            acting_as_plugin.reset(reset)
