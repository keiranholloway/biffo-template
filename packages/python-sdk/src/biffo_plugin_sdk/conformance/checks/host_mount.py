"""#1523 seam 2 — real host mount of the real manifest.

Loads the repo's actual `biffo.plugin.json` through
`biffo_plugin_sdk.plugin.PluginManifest`, then calls the ACTUAL shared
plugin-host discovery and mount code (`plugin_host.discover.discover_plugins`
/ `load_app`, `plugin_host.mount.build_host`, `plugin_host.forward`) — the
same code that runs in the real Lambda — against this repo's own installed
Python. Nothing here re-implements discovery or mounting; a bug in either
would already fail this check because it fails the real host, not a stand-in
for it. That is the whole point (#1523's own framing: "it stubs neither side
of each seam it covers").

## Why a synthetic services root

`discover_plugins(services_root)` expects a directory of
`<name>/biffo.plugin.json` entries (the shape the deployed host's
`BIFFO_PLUGINS_ROOT` actually has, one subdirectory per installed plugin) —
see `services/_plugin-host/src/plugin_host/discover.py`. A plugin repo's own
manifest sits at its repo root instead, so a temporary directory holding one
symlink (named for the manifest's own `name`) pointed at the repo root gives
discovery exactly the shape it expects, without copying anything or teaching
this check a second manifest-reading path.

## Why `module:attr` imports are asserted before anything about routes

`load_app` is `getattr(import_module(module_name), attr)` — a real import of
this repo's own installed code. A manifest pointing `user_ingress.app` at an
attribute that does not exist must fail HERE, naming the ref, rather than at
the first Lambda cold start (#1924's own done-when).

## Why routes are exercised through `build_host`, not re-matched by hand

A manifest-declared `api_routes` entry is not served by the plugin's own
app — Core generates its handler from the table declaration, and the shared
host recognises the declared path/method and forwards it
(`plugin_host.forward.DeclaredRouteForwarder`, `#652`). "Resolves on the
mounted app" is checked by actually building the composed host (`build_host`)
exactly as `plugin_host.app.build_plugin_host` does for the real Lambda, and
sending a real ASGI request for each declared route through it — with a
recording stand-in for the outbound call to Core (the one seam this repo
cannot exercise for real; Core itself is seam 3, #1523 item 3, blocked on
spike #1522) — asserting the request reached that stand-in rather than
falling through to the plugin's own app and 404ing there. A route that is
declared but never actually reaches the forwarder (a mounting-order bug, a
missing `user_ingress`, a path-template mismatch) fails this check instead of
failing silently in production.
"""

from __future__ import annotations

import re
from pathlib import Path
from tempfile import TemporaryDirectory

from biffo_plugin_sdk.plugin import load_manifest

from .. import ConformanceCheckError, ConformanceContext

CHECK_NAME = "host_mount"
IMPLEMENTED = True
NOTE = "the real plugin_host discovers, imports and mounts this repo's own manifest"

#: Substituted for every `{param}` segment in a declared route's path before
#: sending a synthetic request — mirrors the concrete-path convention
#: `services/_plugin-host/tests/test_forward.py` uses for the same purpose.
_PATH_PARAM = re.compile(r"\{[^/}]+\}")

#: `plugin_host.mount._founder_token`'s own literal — not exported (it is
#: module-private), so named here rather than imported. The forwarder sits
#: OUTSIDE the group gate (`plugin_host.forward`'s module docstring), but it
#: still requires a caller token before forwarding anything to Core, so a
#: synthetic request needs one even though this check's stand-in `authorize`
#: never inspects it.
_FOUNDER_TOKEN_HEADER = "X-Biffo-Founder-Token"  # noqa: S105 -- a header name, not a credential


def _concrete_path(path: str) -> str:
    return _PATH_PARAM.sub("1", path)


def run(ctx: ConformanceContext) -> None:  # noqa: C901 -- one check, told as one story
    manifest_path = ctx.repo_root / "biffo.plugin.json"
    if not manifest_path.is_file():
        raise ConformanceCheckError(f"no biffo.plugin.json at {manifest_path}")

    try:
        manifest = load_manifest(manifest_path)
    except (FileNotFoundError, ValueError) as exc:
        raise ConformanceCheckError(f"{manifest_path} failed to validate: {exc}") from exc

    try:
        from plugin_host.discover import DiscoveredPlugin, discover_plugins, load_app
        from plugin_host.mount import MountedPlugin, build_host
    except ImportError as exc:
        raise ConformanceCheckError(
            "biffo-plugin-host is not importable in this environment -- add it (directly, or "
            "via biffo-plugin-sdk's own dependency on it) to this repo's pyproject.toml so "
            "host_mount can exercise the real discovery/mount code rather than skipping: "
            f"{exc}"
        ) from exc

    with TemporaryDirectory(prefix="biffo-plugin-verify-host-mount-") as tmp:
        synthetic_root = Path(tmp)
        (synthetic_root / manifest.name).symlink_to(ctx.repo_root, target_is_directory=True)
        discovered = discover_plugins(synthetic_root)

    matches = [p for p in discovered if p.name == manifest.name]
    if len(matches) != 1:
        raise ConformanceCheckError(
            f"the real plugin_host.discover_plugins found {len(matches)} plugin(s) named "
            f"{manifest.name!r} (expected exactly 1) -- check that {manifest_path} is valid and "
            "declares user_ingress or admin_ingress; a manifest with neither is a data/event-only "
            "plugin discovery correctly skips, which host_mount has nothing to assert about."
        )
    plugin: DiscoveredPlugin = matches[0]

    ingress_refs = [("user_ingress", plugin.app_ref), ("admin_ingress", plugin.admin_app_ref)]
    mounted_ingresses = [(field, ref) for field, ref in ingress_refs if ref]
    if not mounted_ingresses:
        # Currently unreachable via the real discover_plugins: it only ever
        # returns a DiscoveredPlugin for a manifest declaring at least one
        # ingress (see its own "data/event-only plugin" skip, and the
        # `len(matches) != 1` branch above, which already covers "neither
        # declared" for THIS repo's own manifest). Kept as defense-in-depth
        # against that contract changing upstream -- tested indirectly via
        # the `len(matches) != 1` case, per #1363's own "an empty scope must
        # not read as a pass", not exercised directly because there is no
        # manifest shape that reaches it today.
        raise ConformanceCheckError(
            f"{manifest.name} declares neither user_ingress nor admin_ingress -- host_mount has "
            "nothing to mount. An empty scope must not read as a pass (#1363); declare at least "
            "one ingress, or this check should not be relied on for this plugin."
        )
    summary_refs = ", ".join(f"{field}→{ref}" for field, ref in mounted_ingresses)
    print(f"host_mount: {len(mounted_ingresses)} ingress(es) declared [{summary_refs}]", flush=True)

    loaded: dict[str, object] = {}
    for field, ref in mounted_ingresses:
        try:
            loaded[field] = load_app(ref)
        except Exception as exc:
            raise ConformanceCheckError(
                f"{field}.app {ref!r} failed to import via the real plugin_host.load_app "
                f"(getattr(import_module(...), ...)): {exc}"
            ) from exc
    print(f"host_mount: {len(loaded)} ingress(es) imported", flush=True)

    route_count = len(plugin.api_routes)
    print(f"host_mount: {route_count} declared route(s) to resolve", flush=True)

    route_list = ""
    if route_count:
        core_calls: list[tuple[str, str]] = []

        async def _fake_send_to_core(
            *, method: str, path: str, body: bytes | None, user_token: str
        ):
            core_calls.append((method, path))
            return 200, b"{}", "application/json"

        def _always_authorized(token: str, required_group: str) -> object:
            return "conformance-check"

        mounted_plugin = MountedPlugin(
            name=plugin.name,
            app=loaded.get("user_ingress"),
            required_group=plugin.required_group,
            admin_app=loaded.get("admin_ingress"),
            admin_required_group=plugin.admin_required_group,
            api_routes=plugin.api_routes,
        )
        host = build_host(
            [mounted_plugin], authorize=_always_authorized, send_to_core=_fake_send_to_core
        )

        from starlette.testclient import TestClient

        # No `with` block: entering the host's lifespan would run every mounted
        # plugin's OWN startup handler (self-seeding calls to Core, ADR-0021),
        # which this check has no live Core to answer. Declared-route
        # resolution does not need it -- `plugin_host.mount.build_host`'s own
        # test suite (`test_mount.py`) exercises the mounted app the same way.
        client = TestClient(host, raise_server_exceptions=False)

        unresolved: list[str] = []
        for route in plugin.api_routes:
            concrete_path = _concrete_path(route.path)
            url = f"/{plugin.name}{concrete_path}"
            expected_core_path = f"/api/v1/internal/plugins/{plugin.name}{concrete_path}"
            client.request(
                route.method,
                url,
                headers={_FOUNDER_TOKEN_HEADER: "conformance-check"},
            )
            if (route.method, expected_core_path) not in core_calls:
                unresolved.append(f"{route.method} {route.path}")

        if unresolved:
            raise ConformanceCheckError(
                f"{len(unresolved)}/{route_count} declared route(s) did not resolve to a "
                f"forwardable mount on the real host (never reached the forwarder -- fell "
                f"through to the plugin's own app instead): {', '.join(unresolved)}"
            )
        route_list = ", ".join(f"{r.method} {r.path}" for r in plugin.api_routes)

    print(
        f"verify: {len(mounted_ingresses)} ingress(es) mounted [{summary_refs}]; "
        f"{route_count} declared route(s) resolved: {route_list or '<none>'}",
        flush=True,
    )
