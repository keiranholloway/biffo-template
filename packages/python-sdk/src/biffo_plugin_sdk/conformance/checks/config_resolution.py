"""#1523 seam 4 — config resolution end-to-end (biffo-template#1517/#2086/#2096).

#1517 landed `PluginManifest.config: list[ConfigDeclaration]` and the
resolution mechanism in `biffo_plugin_sdk.config`: a manifest declares NEEDS
(name/kind/required/description, never a value), and `get_plugin_config` /
`resolve_secret` turn a declared need into a usable value at runtime, failing
closed on a missing `required` need and never caching a transient SSM failure
as "unconfigured" (marketing#25's lesson).

The check has **two halves**, because two different things can be wrong:

1. **The plugin under verification's own declarations** (`ctx.repo_root`'s
   `biffo.plugin.json`, read like `host_mount` reads it). Every declared need is
   resolved through the real `get_plugin_config`, scoped to the plugin's own
   name. A `required: true` need with no value supplied FAILS the check, naming
   the key and the environment variable that would supply it — #2086's done-when
   ("a plugin declaring a required need with no value fails `plugin verify`").
   A missing or schema-invalid manifest fails too: a check that passes because
   it found nothing to read is the estate's dominant defect shape.
2. **A disposable fixture, covering BOTH kinds** (`secret` and `setting`,
   required and optional), that exercises every fail-closed / classification
   path of the SDK's own resolution code — so a regression in `config.py`
   (a reverted `required` branch for either kind, a required need tolerated
   under a permanently-denied SSM, an empty SSM value taken as resolved, a
   throttle cached as absent, DENIED/ABSENT swapped) goes red HERE regardless
   of what any particular plugin happens to declare. The first version of this
   check had only the fixture half, with secret-only needs: it left the
   setting path unguarded and never looked at a plugin's own declarations
   (#2096).

**What "supplied" means at verify time.** Whether a value is supplied is
ultimately a property of the instance a plugin is installed into, and
`biffo plugin verify` runs pre-install, in CI. The supply channel is the very
one the shared host resolves at runtime (`config.plugin_config_env_names`): a
`setting` is supplied by its `BIFFO_PLUGIN_<PLUGIN>_<NAME>` literal, a `secret`
by its `BIFFO_PLUGIN_<PLUGIN>_<NAME>_PARAMETER` reference. So a plugin that
legitimately declares a required need declares in its CI what stands in for it
(sets those variables) — the failing message says exactly which. For a secret
the reference is resolved against a local stand-in SSM that holds a placeholder
for any path: verify proves the reference IS supplied, not that a real parameter
exists behind it (that is the instance's concern, never real AWS here). A
resolved value is never printed.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from biffo_plugin_sdk.config import (
    ConfigState,
    PluginConfigError,
    PluginConfigTransientError,
    get_plugin_config,
    plugin_config_env_names,
    resolve_secret,
)
from biffo_plugin_sdk.plugin import ConfigDeclaration, ConfigKind, PluginManifest, load_manifest
from biffo_plugin_sdk.signed_client import acting_as_plugin

from .. import ConformanceCheckError, ConformanceContext

CHECK_NAME = "config_resolution"
IMPLEMENTED = True
NOTE = (
    "the plugin's own declared config needs resolve (a required need with no value fails, naming "
    "the key); a disposable secret+setting fixture exercises every fail-closed path and all three "
    "SSM-backed cache states through the real SDK, via a local fake client, never real AWS"
)

#: A name that will never collide with a real installed plugin — this check
#: never mounts anything, it only needs a stable scope for env var names.
_FIXTURE_PLUGIN_NAME = "conformance-config-fixture"
#: These name a fixture manifest's *declared config keys* — a `ConfigDeclaration.name`,
#: never a credential value. They are deliberately NOT called `*_SECRET` / `*secret`:
#: CodeQL's `py/clear-text-{storage,logging}-sensitive-data` classify data by
#: identifier name, so a constant named `_REQUIRED_NEED` made the fixture manifest
#: write and the progress lines read as clear-text secret storage/logging (#2089's
#: alerts 31-33) when the only thing flowing is a synthetic key name. The value
#: resolved for a need is never written or printed anywhere in this module.
_REQUIRED_NEED = "required_need"
_OPTIONAL_NEED = "optional_need"
_REQUIRED_SETTING = "required_setting"
_OPTIONAL_SETTING = "optional_setting"

_FIXTURE_MANIFEST = {
    "name": _FIXTURE_PLUGIN_NAME,
    "version": "0.1.0",
    "config": [
        {
            "name": _REQUIRED_NEED,
            "kind": "secret",
            "required": True,
            "description": "Mandatory reference (#1517's secret fail-closed path).",
        },
        {
            "name": _OPTIONAL_NEED,
            "kind": "secret",
            "required": False,
            "description": "Optional reference (#1517's secret install-anyway path).",
        },
        {
            "name": _REQUIRED_SETTING,
            "kind": "setting",
            "required": True,
            "description": "Mandatory literal (#1517's setting fail-closed path).",
        },
        {
            "name": _OPTIONAL_SETTING,
            "kind": "setting",
            "required": False,
            "description": "Optional literal (#1517's setting install-anyway path).",
        },
    ],
}


class _FakeSsm:
    """A local SSM stand-in — never real AWS. Same shape as
    `biffo_plugin_sdk`'s own `tests/test_config.py` fixture: `params` maps
    parameter name to value; `error`, when set, is raised on every
    `get_parameter` call instead, with a `.response` matching a real
    botocore `ClientError`'s shape so `_classify_ssm_error` in `config.py`
    (the real code, unmodified here) can classify it exactly as it would a
    genuine SSM response.
    """

    def __init__(
        self, params: dict[str, str] | None = None, error: Exception | None = None
    ) -> None:
        self.params = params or {}
        self.error = error

    def get_parameter(self, *, Name: str, WithDecryption: bool) -> dict[str, Any]:  # noqa: N803 -- mirrors botocore's own kwarg casing
        if self.error is not None:
            raise self.error
        if Name not in self.params:
            raise _client_error("ParameterNotFound")
        return {"Parameter": {"Value": self.params[Name]}}


def _client_error(code: str) -> Exception:
    exc = Exception(f"simulated {code}")
    exc.response = {"Error": {"Code": code}}  # type: ignore[attr-defined]
    return exc


def _write_fixture_manifest(directory: Path) -> Path:
    path = directory / "biffo.plugin.json"
    path.write_text(json.dumps(_FIXTURE_MANIFEST), encoding="utf-8")
    return path


def _resolve_as_plugin(
    plugin_name: str, name: str, *, kind: ConfigKind, required: bool, ssm_client: Any
) -> str | None:
    """`get_plugin_config`, scoped to `plugin_name` exactly the way a plugin's
    own runtime code is scoped — `acting_as_plugin` bound the same way
    `plugin_host.mount.group_gate` binds it per request (see `config.py`'s own
    "Scoping" docstring section)."""
    reset = acting_as_plugin.set(plugin_name)
    try:
        return get_plugin_config(name, kind=kind, required=required, ssm_client=ssm_client)
    finally:
        acting_as_plugin.reset(reset)


@contextmanager
def _env(updates: Mapping[str, str | None]) -> Iterator[None]:
    """Set (a `str`) or unset (`None`) each variable for the duration, restoring
    whatever was there afterwards. Unsetting guards against a coincidentally-set
    real variable making a "no value supplied" assertion meaningless."""
    previous = {name: os.environ.get(name) for name in updates}
    try:
        for name, value in updates.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        yield
    finally:
        for name, old in previous.items():
            if old is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = old


class _AnyParameterSsm:
    """Stand-in SSM for the plugin's OWN needs: every referenced path exists and
    holds a placeholder. Verify proves a reference is SUPPLIED, not that a real
    parameter exists behind it (an instance concern); never real AWS."""

    def get_parameter(self, *, Name: str, WithDecryption: bool) -> dict[str, Any]:  # noqa: N803, ARG002 -- mirrors botocore's own kwarg casing
        return {"Parameter": {"Value": "conformance-placeholder"}}


def _supply_env_name(plugin_name: str, decl: ConfigDeclaration) -> str:
    literal_env, parameter_env = plugin_config_env_names(plugin_name, decl.name)
    return parameter_env if decl.kind == "secret" else literal_env


def _load_plugin_manifest(repo_root: Path) -> PluginManifest:
    manifest_path = repo_root / "biffo.plugin.json"
    if not manifest_path.is_file():
        raise ConformanceCheckError(f"no biffo.plugin.json at {manifest_path}")
    try:
        return load_manifest(manifest_path)
    except (FileNotFoundError, ValueError) as exc:
        raise ConformanceCheckError(f"{manifest_path} failed to validate: {exc}") from exc


def _check_plugin_own_needs(manifest: PluginManifest) -> None:
    """Resolve every need the plugin under verification DECLARES; fail, naming
    each key, when a `required: true` one has no value supplied. A required need
    that resolves to nothing WITHOUT raising means the SDK failed open — also a
    failure here, independent of the fixture half."""
    missing: list[str] = []
    for decl in manifest.config:
        try:
            value = _resolve_as_plugin(
                manifest.name,
                decl.name,
                kind=decl.kind,
                required=decl.required,
                ssm_client=_AnyParameterSsm(),
            )
        except PluginConfigError:
            missing.append(
                f"{decl.name!r} ({decl.kind}; supply {_supply_env_name(manifest.name, decl)})"
            )
            continue
        if decl.required and value is None:
            missing.append(
                f"{decl.name!r} ({decl.kind}; supply {_supply_env_name(manifest.name, decl)})"
            )
    if missing:
        raise ConformanceCheckError(
            f"plugin {manifest.name!r} declares required config need(s) with no value supplied: "
            f"{', '.join(missing)} -- a required need with no value fails closed at install, so "
            "verify fails closed too (set the named variable(s) in this run's environment)"
        )
    if manifest.config:
        print(
            f"config_resolution: plugin {manifest.name!r}: {len(manifest.config)} config need(s) "
            "declared, every required one supplied",
            flush=True,
        )
    else:
        print(f"config_resolution: plugin {manifest.name!r} declares no config needs", flush=True)


def _expect_fail_closed(
    what: str,
    name: str,
    *,
    kind: ConfigKind,
    ssm_client: Any,
    state: ConfigState = ConfigState.ABSENT,
) -> None:
    """A `required` need must raise `PluginConfigError` naming `name`, in `state`."""
    try:
        _resolve_as_fixture(name, kind=kind, required=True, ssm_client=ssm_client)
    except PluginConfigError as exc:
        if name not in str(exc):
            raise ConformanceCheckError(
                f"{what} failed closed, but its error did not name the missing key {name!r}: {exc}"
            ) from exc
        if exc.state is not state:
            raise ConformanceCheckError(
                f"{what} failed closed, but reported state {exc.state.value!r}, "
                f"expected {state.value!r}"
            ) from exc
        return
    raise ConformanceCheckError(
        f"{what} ({name!r}) resolved successfully instead of failing closed -- the fail-closed "
        "path this seam exists to enforce is not enforced"
    )


def _expect_none_when_optional(what: str, name: str, *, kind: ConfigKind, ssm_client: Any) -> None:
    try:
        result = _resolve_as_fixture(name, kind=kind, required=False, ssm_client=ssm_client)
    except PluginConfigError as exc:
        raise ConformanceCheckError(
            f"optional {kind} need {name!r} ({what}) raised instead of resolving to None -- an "
            f"optional need must not block install: {exc}"
        ) from exc
    if result is not None:
        raise ConformanceCheckError(
            f"optional {kind} need {name!r} ({what}) returned a value instead of None"
        )


def _resolve_as_fixture(
    name: str, *, kind: ConfigKind, required: bool, ssm_client: Any
) -> str | None:
    return _resolve_as_plugin(
        _FIXTURE_PLUGIN_NAME, name, kind=kind, required=required, ssm_client=ssm_client
    )


def _check_sdk_contract_with_fixture() -> None:
    with TemporaryDirectory(prefix="biffo-plugin-verify-config-resolution-") as tmp:
        manifest_path = _write_fixture_manifest(Path(tmp))
        try:
            manifest = load_manifest(manifest_path)
        except (FileNotFoundError, ValueError) as exc:
            raise ConformanceCheckError(
                f"conformance's own fixture manifest at {manifest_path} failed to validate "
                f"through the real PluginManifest schema: {exc}"
            ) from exc

    declared = {decl.name: decl for decl in manifest.config}
    expected = {
        _REQUIRED_NEED: ("secret", True),
        _OPTIONAL_NEED: ("secret", False),
        _REQUIRED_SETTING: ("setting", True),
        _OPTIONAL_SETTING: ("setting", False),
    }
    got = {name: (decl.kind, decl.required) for name, decl in declared.items()}
    if got != expected:
        raise ConformanceCheckError(
            "conformance's own fixture manifest did not round-trip its config: declarations "
            f"through the real PluginManifest -- got {got}, expected {expected}"
        )

    def ref(name: str) -> str:
        return plugin_config_env_names(_FIXTURE_PLUGIN_NAME, name)[1]

    def literal(name: str) -> str:
        return plugin_config_env_names(_FIXTURE_PLUGIN_NAME, name)[0]

    unset: dict[str, str | None] = {
        ref(_REQUIRED_NEED): None,
        ref(_OPTIONAL_NEED): None,
        literal(_REQUIRED_SETTING): None,
        literal(_OPTIONAL_SETTING): None,
    }
    path = f"/conformance/{_FIXTURE_PLUGIN_NAME}/{_REQUIRED_NEED}"

    # --- (1) required needs, both kinds, with no value supplied fail closed, naming the key ---
    with _env(unset):
        _expect_fail_closed(
            "a required secret need with no value supplied",
            _REQUIRED_NEED,
            kind="secret",
            ssm_client=_FakeSsm(),
        )
    print(
        "config_resolution: required secret need with no value fails closed, naming the key",
        flush=True,
    )
    with _env(unset):
        _expect_fail_closed(
            "a required setting need with no value supplied",
            _REQUIRED_SETTING,
            kind="setting",
            ssm_client=_FakeSsm(),
        )
    print(
        "config_resolution: required setting need with no value fails closed, naming the key",
        flush=True,
    )

    # --- (2) optional needs, both kinds, with no value supplied still install (None) ---
    with _env(unset):
        _expect_none_when_optional(
            "no value supplied", _OPTIONAL_NEED, kind="secret", ssm_client=_FakeSsm()
        )
        _expect_none_when_optional(
            "no value supplied", _OPTIONAL_SETTING, kind="setting", ssm_client=_FakeSsm()
        )
    print(
        "config_resolution: optional needs (secret and setting) with no value still install "
        "(resolve to None)",
        flush=True,
    )

    # --- (3) supplied needs resolve (guards a resolver that always fails, or always drops) ---
    supplied_literal = "fixture-literal"
    supplied_stored = "fixture-stored"
    with _env({**unset, literal(_REQUIRED_SETTING): supplied_literal, ref(_REQUIRED_NEED): path}):
        setting = _resolve_as_fixture(
            _REQUIRED_SETTING, kind="setting", required=True, ssm_client=_FakeSsm()
        )
        stored = _resolve_as_fixture(
            _REQUIRED_NEED,
            kind="secret",
            required=True,
            ssm_client=_FakeSsm(params={path: supplied_stored}),
        )
    if setting != supplied_literal:
        raise ConformanceCheckError(
            f"a supplied setting need ({_REQUIRED_SETTING!r}) did not resolve to its supplied value"
        )
    if stored != supplied_stored:
        raise ConformanceCheckError(
            f"a supplied secret need ({_REQUIRED_NEED!r}) did not resolve to its supplied value"
        )
    print("config_resolution: supplied needs (secret and setting) resolve", flush=True)

    with _env({**unset, ref(_REQUIRED_NEED): path, ref(_OPTIONAL_NEED): path}):
        # --- (4) permanently-denied SSM: required fails closed (DENIED); optional -> None
        denied_ssm = _FakeSsm(error=_client_error("AccessDeniedException"))
        _expect_fail_closed(
            "a required need under permanently-denied SSM",
            _REQUIRED_NEED,
            kind="secret",
            ssm_client=denied_ssm,
            state=ConfigState.DENIED,
        )
        _expect_none_when_optional(
            "permanently-denied SSM", _OPTIONAL_NEED, kind="secret", ssm_client=denied_ssm
        )
        print(
            "config_resolution: required need under permanently-denied SSM fails closed", flush=True
        )

        # --- (5) an SSM parameter holding an empty value is 'not configured', never resolved ---
        empty_ssm = _FakeSsm(params={path: "   "})
        empty = resolve_secret(_FIXTURE_PLUGIN_NAME, _REQUIRED_NEED, ssm_client=empty_ssm)
        if empty.state is not ConfigState.ABSENT:
            raise ConformanceCheckError(
                f"an SSM parameter holding an empty value classified as {empty.state.value!r}, "
                "expected 'absent' (an empty value is not a configured one)"
            )
        _expect_fail_closed(
            "a required need whose SSM value is empty",
            _REQUIRED_NEED,
            kind="secret",
            ssm_client=empty_ssm,
        )
        print("config_resolution: required need whose SSM value is empty fails closed", flush=True)

        # --- (6) all three SSM-backed cache states, via the local fake client only ---
        absent = resolve_secret(_FIXTURE_PLUGIN_NAME, _REQUIRED_NEED, ssm_client=_FakeSsm())
        if absent.state is not ConfigState.ABSENT:
            raise ConformanceCheckError(
                f"SSM ParameterNotFound (confirmed-absent) classified as {absent.state.value!r}, "
                "expected 'absent'"
            )
        _expect_fail_closed(
            "a required need whose SSM parameter is confirmed absent",
            _REQUIRED_NEED,
            kind="secret",
            ssm_client=_FakeSsm(),
        )

        denied = resolve_secret(_FIXTURE_PLUGIN_NAME, _REQUIRED_NEED, ssm_client=denied_ssm)
        if denied.state is not ConfigState.DENIED:
            raise ConformanceCheckError(
                f"SSM AccessDeniedException (permanently-denied) classified as "
                f"{denied.state.value!r}, expected 'denied'"
            )

        throttled = _FakeSsm(error=_client_error("ThrottlingException"))
        for what, resolve in (
            (
                "resolve_secret",
                lambda: resolve_secret(_FIXTURE_PLUGIN_NAME, _REQUIRED_NEED, ssm_client=throttled),
            ),
            (
                "a required need via get_plugin_config",
                lambda: _resolve_as_fixture(
                    _REQUIRED_NEED, kind="secret", required=True, ssm_client=throttled
                ),
            ),
            (
                "an optional need via get_plugin_config",
                lambda: _resolve_as_fixture(
                    _OPTIONAL_NEED, kind="secret", required=False, ssm_client=throttled
                ),
            ),
        ):
            try:
                resolve()
            except PluginConfigTransientError:
                continue
            raise ConformanceCheckError(
                f"an SSM throttling error (transient) through {what} did not raise "
                "PluginConfigTransientError -- it was resolved to a cacheable state or value "
                "instead (marketing#25's regression)"
            )
    print(
        "config_resolution: all three SSM-backed cache states exercised "
        "(confirmed-absent, permanently-denied, transient)",
        flush=True,
    )


def run(ctx: ConformanceContext) -> None:
    _check_plugin_own_needs(_load_plugin_manifest(ctx.repo_root))
    _check_sdk_contract_with_fixture()
