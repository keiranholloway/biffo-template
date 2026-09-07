"""Per-plugin configuration resolution (biffo-template#1517).

A plugin manifest's ``config:`` block (``ConfigDeclaration`` in ``plugin.py``)
declares NEEDS — names, kinds (``secret``/``setting``), whether they are
required — never values. ``biffo plugin install`` is where an instance
supplies the actual value, by reference: an SSM parameter *path* for a
secret, a literal for a setting (``cli/src/commands/plugin-install.ts``). This
module is the other end — how the shared plugin host (and a plugin's own code,
running on it) turns that reference into a usable value at runtime, over the
already-shipped env-passing channel (``var.plugin_host_environment``,
biffo-template#1534/#1535/#1550/#1560/#1561).

**Naming, and why it is what it is.** Every value lives behind an env var
named ``BIFFO_PLUGIN_<PLUGIN>_<NAME>`` (a setting's literal value) or
``BIFFO_PLUGIN_<PLUGIN>_<NAME>_PARAMETER`` (a secret's SSM parameter path) —
the second form extends the existing ``<NAME>_PARAMETER`` convention already
used by ``services/_plugins/agent-runtime``'s ``OPENROUTER_API_KEY_PARAMETER``
and ``orchestrator``'s ``WHATSAPP_ACCESS_TOKEN_PARAMETER`` with a per-plugin
prefix, rather than inventing a second convention. The prefix is what makes
two plugins that both declare a config entry named e.g. ``api_key`` not
collide on the shared host's one process-wide environment — the CLI computes
these exact names at install time (see ``cli/src/lib/plugin-config-resolution
.ts``'s ``pluginConfigEnvNames``, which must stay byte-for-byte identical to
:func:`plugin_config_env_names` below).

**Scoping — "marketing can read marketing's config and nothing else".** The
shared host runs every installed plugin's code in one Lambda process, so
nothing at the OS level stops a plugin reading ``os.environ`` directly and
finding another plugin's variable if it can guess the name — true per-process
isolation is not achievable here for the same reason ADR-0021's 2026-07-26
amendment rejected per-plugin STS scoping (#579): the shared-host trust model
is a deliberate trade, not an oversight this module can undo. What it *can*
enforce is scoping **by construction**: :func:`get_plugin_config` never takes
a plugin name as a parameter a caller supplies — it reads
``biffo_plugin_sdk.acting_as_plugin``, the identity
``plugin_host.mount.group_gate`` already binds per request for exactly this
purpose (ADR-0021 §1a, to stamp the outbound ``X-Biffo-Plugin`` header). A
plugin's own code calling ``get_plugin_config("api_key", kind="secret")`` gets
routed to its OWN scoped env vars because there is no argument through which
it could name a different plugin.

**Three-state resolution (marketing#25's lesson, promoted here so it is
learned once instead of relearned per plugin).** A secret's genuine absence
and a transient SSM failure must never be confused — caching a transient
error as "unconfigured" disabled a real, working feature for a warm
container's entire remaining life in marketing#25, reporting a
misconfiguration that did not exist:

- ``ConfigState.ABSENT`` — no ``..._PARAMETER`` env var is set, or SSM
  reports the parameter genuinely does not exist. Safe to treat as final —
  this really is "not configured".
- ``ConfigState.DENIED`` — SSM reports access denied. Also safe to treat as
  final (a permissions problem does not go away on retry within the same
  request), but distinct from ``ABSENT`` so an operator reading logs is not
  told "not configured" when the true story is "misconfigured IAM".
- **Transient** (throttling, timeout, connection failure) is deliberately
  **not** a ``ConfigState`` at all — :func:`resolve_secret` raises
  :class:`PluginConfigTransientError` instead of returning one, so there is
  no value a caller could mistakenly cache as final. Callers should let this
  propagate as a failed request/attempt, not swallow it into "unconfigured".
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from .signed_client import acting_as_plugin

if TYPE_CHECKING:
    from .plugin import ConfigKind


class ConfigState(StrEnum):
    """The three resolvable outcomes for a `kind: secret` value. A transient
    failure is deliberately NOT a member — see the module docstring — so it can
    never be constructed into a value a caller could mistake for a final one."""

    RESOLVED = "resolved"
    ABSENT = "absent"
    DENIED = "denied"


class PluginConfigError(Exception):
    """A `required: true` config value could not be resolved to a usable value.

    `state` is always ABSENT or DENIED — never raised for a transient failure,
    which is a different exception (`PluginConfigTransientError`) precisely so
    the two are not interchangeable at the `except` site.
    """

    def __init__(self, name: str, state: ConfigState, detail: str) -> None:
        super().__init__(f"config {name!r} could not be resolved ({state.value}): {detail}")
        self.name = name
        self.state = state


class PluginConfigTransientError(Exception):
    """SSM could not be reached this attempt (throttling, timeout, network).

    Never cache this as "unconfigured" (marketing#25) — let it propagate as a
    failed attempt so the next request tries again.
    """

    def __init__(self, name: str, detail: str) -> None:
        super().__init__(f"config {name!r} is temporarily unavailable: {detail}")
        self.name = name


@dataclass(frozen=True)
class SecretResolution:
    """The outcome of resolving one `kind: secret` config value.

    `value` is set only when `state is ConfigState.RESOLVED`; `detail` carries
    a human-readable reason for the other two states (never the credential).
    """

    state: ConfigState
    value: str | None = None
    detail: str = ""


def plugin_config_env_names(plugin_name: str, config_name: str) -> tuple[str, str]:
    """``(literal_env, parameter_env)`` for one plugin's declared config name.

    Scoped by plugin name so two plugins declaring the same ``config_name``
    (e.g. both calling it ``api_key``) never collide on the shared host's one
    process-wide environment. Must stay byte-for-byte identical to the CLI's
    own ``pluginConfigEnvNames`` (``cli/src/lib/plugin-config-resolution.ts``)
    — the two are independently maintained (Python vs. TypeScript, no shared
    import is possible across that boundary), so each side pins the exact
    computed string in its own tests rather than trusting the two functions
    to agree by inspection alone.
    """
    prefix = f"BIFFO_PLUGIN_{plugin_name.upper().replace('-', '_')}_{config_name.upper()}"
    return prefix, f"{prefix}_PARAMETER"


def resolve_setting(plugin_name: str, config_name: str) -> str | None:
    """A `kind: setting` value: a literal, read directly from the scoped env
    var. `None` if unset — the caller decides whether that is fatal."""
    literal_env, _ = plugin_config_env_names(plugin_name, config_name)
    value = os.environ.get(literal_env, "").strip()
    return value or None


def _classify_ssm_error(exc: Exception) -> ConfigState | None:
    """`ABSENT`/`DENIED` are cacheable and returned directly; anything else —
    including every shape of throttling, timeout or connection failure — is
    transient and returns `None`, so the caller must raise rather than cache.
    """
    response = getattr(exc, "response", None)
    error_code = ""
    if isinstance(response, dict):
        error_code = str(response.get("Error", {}).get("Code", ""))
    if error_code == "ParameterNotFound":
        return ConfigState.ABSENT
    if error_code in ("AccessDeniedException", "AccessDenied"):
        return ConfigState.DENIED
    return None


def _default_ssm_client() -> Any:
    # Lazy, like signed_client.py's own botocore imports — biffo-plugin-sdk
    # never requires botocore to import, only to actually resolve a secret at
    # runtime (preinstalled in the AWS Lambda Python runtime; install the
    # `sigv4` extra to use this outside Lambda).
    import botocore.session

    return botocore.session.get_session().create_client("ssm")


def resolve_secret(
    plugin_name: str,
    config_name: str,
    *,
    ssm_client: Any | None = None,
) -> SecretResolution:
    """A `kind: secret` value, three-state (see module docstring).

    Raises :class:`PluginConfigTransientError` rather than returning a state
    for a transient SSM failure — there is deliberately no `SecretResolution`
    a caller could construct or receive for that case, closing off the
    caching mistake structurally rather than relying on caller discipline.
    """
    _, parameter_env = plugin_config_env_names(plugin_name, config_name)
    parameter = os.environ.get(parameter_env, "").strip()
    if not parameter:
        return SecretResolution(state=ConfigState.ABSENT, detail=f"{parameter_env} is not set")

    client = ssm_client if ssm_client is not None else _default_ssm_client()

    try:
        response = client.get_parameter(Name=parameter, WithDecryption=True)
    except Exception as exc:  # noqa: BLE001 — botocore raises many shapes; classify below
        state = _classify_ssm_error(exc)
        if state is None:
            raise PluginConfigTransientError(config_name, str(exc)) from exc
        return SecretResolution(state=state, detail=str(exc))

    value = str(response["Parameter"]["Value"]).strip()
    if not value:
        return SecretResolution(
            state=ConfigState.ABSENT, detail=f"SSM parameter {parameter} holds an empty value"
        )
    return SecretResolution(state=ConfigState.RESOLVED, value=value)


def get_plugin_config(
    config_name: str,
    *,
    kind: ConfigKind,
    required: bool = True,
    ssm_client: Any | None = None,
) -> str | None:
    """Resolve one of the CURRENT plugin's own declared config values.

    Scoped automatically to ``acting_as_plugin.get()`` — see the module
    docstring's "Scoping" section for why that is what makes this safe to
    expose to plugin code at all: there is no parameter here through which a
    plugin could name a different plugin's config.

    Raises :class:`PluginConfigError` when ``required`` and the value is not
    resolvable (``ABSENT``/``DENIED``). Raises :class:`PluginConfigTransientError`
    (never a cached "unconfigured") if SSM could not be reached this attempt —
    let it propagate as a request failure rather than swallowing it.
    """
    plugin_name = acting_as_plugin.get()
    if not plugin_name:
        raise PluginConfigError(
            config_name,
            ConfigState.ABSENT,
            "no plugin identity is bound — get_plugin_config must be called from "
            "within a gated plugin request (plugin_host.mount.group_gate binds it)",
        )

    if kind == "setting":
        value = resolve_setting(plugin_name, config_name)
        if value is None and required:
            raise PluginConfigError(config_name, ConfigState.ABSENT, "setting not supplied")
        return value

    if kind == "secret":
        resolution = resolve_secret(plugin_name, config_name, ssm_client=ssm_client)
        if resolution.state != ConfigState.RESOLVED:
            if required:
                raise PluginConfigError(config_name, resolution.state, resolution.detail)
            return None
        return resolution.value

    raise ValueError(f"unknown config kind {kind!r}; expected 'secret' or 'setting'")
