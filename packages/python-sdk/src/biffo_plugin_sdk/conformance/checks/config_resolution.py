"""#1523 seam 4 — config resolution end-to-end (biffo-template#1517/#2086).

#1517 landed `PluginManifest.config: list[ConfigDeclaration]` and the
resolution mechanism in `biffo_plugin_sdk.config`: a manifest declares NEEDS
(name/kind/required/description, never a value), and `get_plugin_config` /
`resolve_secret` turn a declared need into a usable value at runtime, failing
closed on a missing `required` need and never caching a transient SSM failure
as "unconfigured" (marketing#25's lesson). Nothing under this `conformance/`
package exercised that seam before this check — it sat as a declared,
not-implemented stub since #1924 pending #1517's own landing.

**Why this check builds its own fixture manifest instead of reading
`ctx.repo_root`'s real one**, unlike `host_mount`. `host_mount` reads the
*actual* repo under verification because ingress mounting is unconditionally
safe to assert about a live manifest — a plugin either mounts or it does not,
regardless of what the check wants to prove. Config resolution is different:
whether a `required` need's value is *supplied* is a property of the
**instance the plugin is installed into**, not of the plugin repo itself, and
`biffo plugin verify` runs pre-install, in CI, with no instance's SSM
parameters or supplied settings anywhere nearby. A real plugin that
legitimately declares a `required: true` secret (none currently do — see
`services/_plugins/{orchestrator,agent-runtime}/biffo.plugin.json` and
`_skeletons/plugin-template/biffo.plugin.json`, all three carry no `config`
block at all) would have no value supplied at verify time by construction,
every run, forever. Asserting fail-closed behaviour against *that* manifest
would therefore either (a) permanently fail every plugin that ever declares a
required need, which is not what #1517 built, or (b) require this check to
somehow know which declared needs are "supplied" in CI, which does not exist
as a concept. So this check proves the SDK-level CONTRACT instead — "does a
required declaration with no value fail closed, does an optional one still
resolve, are the three SSM cache states classified correctly" — with its own
disposable fixture manifest, loaded through the real `PluginManifest` /
`ConfigDeclaration` schema (`load_manifest`) so a bug in the declare side
would still fail this check, and resolved through the real
`biffo_plugin_sdk.config` functions (`get_plugin_config`, `resolve_secret`) so
a bug in the resolve side would too. The only stand-in is SSM itself — a
local `_FakeSsm`, exactly as `resolve_secret`'s own `ssm_client` parameter is
built to accept, never real AWS (this check has no `dsn` and needs none).
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
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
from biffo_plugin_sdk.plugin import load_manifest
from biffo_plugin_sdk.signed_client import acting_as_plugin

from .. import ConformanceCheckError, ConformanceContext

CHECK_NAME = "config_resolution"
IMPLEMENTED = True
NOTE = (
    "a disposable fixture manifest's config: needs resolve/fail-closed through the real SDK; "
    "all three SSM-backed cache states exercised via a local fake client, never real AWS"
)

#: A name that will never collide with a real installed plugin — this check
#: never mounts anything, it only needs a stable scope for env var names.
_FIXTURE_PLUGIN_NAME = "conformance-config-fixture"
#: These name a fixture manifest's *declared config keys* — a `ConfigDeclaration.name`,
#: never a credential value — so ruff's hardcoded-password heuristic (S105) doesn't apply.
_REQUIRED_SECRET = "required_secret"  # noqa: S105
_OPTIONAL_SECRET = "optional_secret"  # noqa: S105

_FIXTURE_MANIFEST = {
    "name": _FIXTURE_PLUGIN_NAME,
    "version": "0.1.0",
    "config": [
        {
            "name": _REQUIRED_SECRET,
            "kind": "secret",
            "required": True,
            "description": "Mandatory credential (#1517's fail-closed path).",
        },
        {
            "name": _OPTIONAL_SECRET,
            "kind": "secret",
            "required": False,
            "description": "Optional credential (#1517's install-anyway path).",
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


def _resolve_as_fixture_plugin(name: str, *, required: bool, ssm_client: Any) -> str | None:
    """`get_plugin_config`, scoped to the fixture plugin identity exactly the
    way a plugin's own runtime code is scoped — `acting_as_plugin` bound the
    same way `plugin_host.mount.group_gate` binds it per request (see
    `config.py`'s own "Scoping" docstring section)."""
    reset = acting_as_plugin.set(_FIXTURE_PLUGIN_NAME)
    try:
        return get_plugin_config(name, kind="secret", required=required, ssm_client=ssm_client)
    finally:
        acting_as_plugin.reset(reset)


@contextmanager
def _without_env(name: str) -> Iterator[None]:
    """Ensure `name` is unset for the duration, restoring whatever was there
    afterward. Guards against a coincidentally-set real env var making a "no
    value supplied" assertion meaningless — in practice
    `_FIXTURE_PLUGIN_NAME`'s namespace can't collide with a real plugin's,
    but the check should not depend on that being true by luck."""
    previous = os.environ.pop(name, None)
    try:
        yield
    finally:
        if previous is not None:
            os.environ[name] = previous


@contextmanager
def _with_env(name: str, value: str) -> Iterator[None]:
    previous = os.environ.get(name)
    os.environ[name] = value
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = previous


def run(ctx: ConformanceContext) -> None:  # noqa: ARG001 -- self-contained fixture; unused, see module docstring
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
    if _REQUIRED_SECRET not in declared or _OPTIONAL_SECRET not in declared:
        raise ConformanceCheckError(
            "conformance's own fixture manifest did not round-trip its config: declarations "
            f"through the real PluginManifest -- got {sorted(declared)}, expected "
            f"{sorted([_REQUIRED_SECRET, _OPTIONAL_SECRET])}"
        )

    required_param_env = plugin_config_env_names(_FIXTURE_PLUGIN_NAME, _REQUIRED_SECRET)[1]
    optional_param_env = plugin_config_env_names(_FIXTURE_PLUGIN_NAME, _OPTIONAL_SECRET)[1]

    # --- (1) a required need with no value supplied fails closed, naming the key ---
    with _without_env(required_param_env):
        try:
            _resolve_as_fixture_plugin(_REQUIRED_SECRET, required=True, ssm_client=_FakeSsm())
        except PluginConfigError as exc:
            if _REQUIRED_SECRET not in str(exc):
                raise ConformanceCheckError(
                    f"a required config need with no value failed closed, but its error did not "
                    f"name the missing key {_REQUIRED_SECRET!r}: {exc}"
                ) from exc
        else:
            raise ConformanceCheckError(
                f"a required:true config need ({_REQUIRED_SECRET!r}) with no value supplied "
                "resolved successfully instead of failing closed -- #1517's fail-closed path is "
                "not enforced"
            )
    print(
        f"config_resolution: required need '{_REQUIRED_SECRET}' with no value fails closed, "
        "naming the key",
        flush=True,
    )

    # --- (2) an optional need with no value supplied still installs (resolves to None) ---
    with _without_env(optional_param_env):
        try:
            result = _resolve_as_fixture_plugin(
                _OPTIONAL_SECRET, required=False, ssm_client=_FakeSsm()
            )
        except PluginConfigError as exc:
            raise ConformanceCheckError(
                f"optional config need {_OPTIONAL_SECRET!r} (required=False) with no value "
                f"supplied raised instead of resolving to None -- an optional need must not "
                f"block install: {exc}"
            ) from exc
    if result is not None:
        raise ConformanceCheckError(
            f"optional config need {_OPTIONAL_SECRET!r} with no value supplied returned "
            f"{result!r} instead of None -- an optional need must not block install"
        )
    print(
        f"config_resolution: optional need '{_OPTIONAL_SECRET}' with no value still installs "
        "(resolves to None)",
        flush=True,
    )

    # --- (3) all three SSM-backed cache states, via the local fake client only ---
    parameter_path = f"/conformance/{_FIXTURE_PLUGIN_NAME}/{_REQUIRED_SECRET}"
    with _with_env(required_param_env, parameter_path):
        absent = resolve_secret(
            _FIXTURE_PLUGIN_NAME, _REQUIRED_SECRET, ssm_client=_FakeSsm(params={})
        )
        if absent.state is not ConfigState.ABSENT:
            raise ConformanceCheckError(
                f"SSM ParameterNotFound (confirmed-absent) classified as {absent.state.value!r}, "
                "expected 'absent'"
            )

        denied = resolve_secret(
            _FIXTURE_PLUGIN_NAME,
            _REQUIRED_SECRET,
            ssm_client=_FakeSsm(error=_client_error("AccessDeniedException")),
        )
        if denied.state is not ConfigState.DENIED:
            raise ConformanceCheckError(
                f"SSM AccessDeniedException (permanently-denied) classified as "
                f"{denied.state.value!r}, expected 'denied'"
            )

        try:
            resolve_secret(
                _FIXTURE_PLUGIN_NAME,
                _REQUIRED_SECRET,
                ssm_client=_FakeSsm(error=_client_error("ThrottlingException")),
            )
        except PluginConfigTransientError:
            pass
        else:
            raise ConformanceCheckError(
                "an SSM throttling error (transient) resolved to a cacheable ConfigState instead "
                "of raising PluginConfigTransientError -- marketing#25's regression"
            )
    print(
        "config_resolution: all three SSM-backed cache states exercised "
        "(confirmed-absent, permanently-denied, transient)",
        flush=True,
    )
