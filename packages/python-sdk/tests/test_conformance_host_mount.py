"""`biffo_plugin_sdk.conformance.host_mount` (biffo-template#1523 seam 2, #1924).

This is the one implemented check M2 ships, and it is deliberately the check
that stubs neither side of the seam: it loads a real ``biffo.plugin.json``
through the real ``PluginManifest``, calls the real
``plugin_host.discover.discover_plugins``/``load_app`` against a real
importable package on disk, and drives a real declared route through the real
``plugin_host.mount.build_host``. These tests build that real fixture rather
than mocking any part of it — mocking the plugin_host boundary would be
exactly the re-implementation this feature exists to delete (see the check
module's own docstring).

Covers #1924's own done-when directly:

- the marketing-shaped success case (N ingresses mounted, N routes resolved,
  printed as the denominator before the verdict, #1363's shape);
- a `user_ingress.app` pointed at a non-existent attribute exits non-zero
  **naming the ref** — caught here, not at the first Lambda cold start;
- a manifest declaring neither ingress is a failure, not a vacuous pass;
- a declared route that never reaches the real forwarder (undeclared on the
  host side) is caught rather than silently 404ing.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from biffo_plugin_sdk.conformance import ConformanceCheckError, ConformanceContext
from biffo_plugin_sdk.conformance.checks import host_mount


def _write_manifest(repo_root: Path, manifest: dict) -> None:
    (repo_root / "biffo.plugin.json").write_text(json.dumps(manifest), encoding="utf-8")


def _write_fixture_app(repo_root: Path, package_name: str, *, with_admin: bool = False) -> None:
    """A real, importable ASGI app package at ``repo_root/<package_name>/``,
    the same shape a plugin repo's own `app.py` has (a top-level package
    importable from the repo root, e.g. `marketing.app:app`)."""
    pkg = repo_root / package_name
    pkg.mkdir()
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "app.py").write_text(
        "from starlette.applications import Starlette\n"
        "from starlette.responses import JSONResponse\n"
        "from starlette.routing import Route\n\n"
        "async def _catch_all(request):\n"
        "    return JSONResponse({'served_by': 'plugin'}, status_code=404)\n\n"
        "app = Starlette(routes=[Route('/{rest:path}', _catch_all)])\n",
        encoding="utf-8",
    )
    if with_admin:
        (pkg / "admin_app.py").write_text(
            "from starlette.applications import Starlette\napp = Starlette(routes=[])\n",
            encoding="utf-8",
        )


@pytest.fixture
def fixture_repo(tmp_path, monkeypatch):
    """A synthetic plugin repo: `tmp_path` is both the manifest's home
    (`ctx.repo_root`) and, via `sys.path`, where its declared `module:attr`
    app references actually import from — the same relationship a real
    plugin repo has between its root and its own installed package."""
    monkeypatch.syspath_prepend(str(tmp_path))
    return tmp_path


def _base_manifest(**overrides) -> dict:
    manifest = {
        "name": "fixture_plugin",
        "version": "0.1.0",
        "tables": [{"name": "widgets"}],
    }
    manifest.update(overrides)
    return manifest


class TestHostMountSuccess:
    def test_user_and_admin_ingress_mounted_and_declared_route_resolved(self, fixture_repo):
        _write_fixture_app(fixture_repo, "fixture_plugin", with_admin=True)
        _write_manifest(
            fixture_repo,
            _base_manifest(
                user_ingress={"app": "fixture_plugin.app:app", "required_group": "founder"},
                admin_ingress={
                    "app": "fixture_plugin.admin_app:app",
                    "required_group": "admin",
                },
                api_routes=[
                    {"method": "GET", "path": "/widgets", "table": "widgets", "operation": "list"}
                ],
            ),
        )

        host_mount.run(ConformanceContext(repo_root=fixture_repo))

    def test_prints_the_denominator_before_the_verdict(self, fixture_repo, capsys):
        """#1924's own done-when, verbatim shape: `verify: N ingress(es)
        mounted [...]; N declared route(s) resolved: <list>` — a green with no
        printed scope is a failure of this feature (#1363)."""
        _write_fixture_app(fixture_repo, "fixture_plugin")
        _write_manifest(
            fixture_repo,
            _base_manifest(
                user_ingress={"app": "fixture_plugin.app:app", "required_group": "founder"},
                api_routes=[
                    {"method": "GET", "path": "/widgets", "table": "widgets", "operation": "list"},
                    {
                        "method": "GET",
                        "path": "/widgets/{id}",
                        "table": "widgets",
                        "operation": "read",
                    },
                ],
            ),
        )

        host_mount.run(ConformanceContext(repo_root=fixture_repo))

        out = capsys.readouterr().out
        assert "1 ingress(es) declared [user_ingress→fixture_plugin.app:app]" in out
        assert "2 declared route(s) to resolve" in out
        assert "verify: 1 ingress(es) mounted" in out
        assert "2 declared route(s) resolved: GET /widgets, GET /widgets/{id}" in out

    def test_a_manifest_with_zero_declared_routes_still_passes(self, fixture_repo, capsys):
        _write_fixture_app(fixture_repo, "fixture_plugin")
        _write_manifest(
            fixture_repo,
            _base_manifest(
                user_ingress={"app": "fixture_plugin.app:app", "required_group": "founder"},
            ),
        )

        host_mount.run(ConformanceContext(repo_root=fixture_repo))
        assert "0 declared route(s) resolved: <none>" in capsys.readouterr().out


class TestHostMountFailures:
    def test_missing_manifest_names_the_path(self, tmp_path):
        with pytest.raises(ConformanceCheckError, match="no biffo.plugin.json at"):
            host_mount.run(ConformanceContext(repo_root=tmp_path))

    def test_invalid_manifest_json_is_reported_not_raised_raw(self, tmp_path):
        (tmp_path / "biffo.plugin.json").write_text("{not valid json", encoding="utf-8")
        with pytest.raises(ConformanceCheckError, match="failed to validate"):
            host_mount.run(ConformanceContext(repo_root=tmp_path))

    def test_neither_ingress_declared_is_a_failure_not_a_vacuous_pass(self, fixture_repo):
        """#1363's shape: an empty scope must not read as a pass.

        The real `discover_plugins` treats a manifest with neither ingress as
        a data/event-only plugin and skips it entirely (by design — see its
        own docstring), so this surfaces as the `len(matches) != 1` branch
        rather than host_mount's own "nothing to mount" guard, which that
        upstream skip makes unreachable for this repo's own manifest (see the
        comment above that guard in `host_mount.py`)."""
        _write_manifest(fixture_repo, _base_manifest())
        with pytest.raises(ConformanceCheckError, match="found 0 plugin.s. named 'fixture_plugin'"):
            host_mount.run(ConformanceContext(repo_root=fixture_repo))

    def test_a_nonexistent_attribute_ref_fails_naming_the_ref(self, fixture_repo):
        """#1924's own done-when: pointing `user_ingress.app` at an attribute
        that does not exist exits non-zero naming the ref, rather than the
        first Lambda cold start discovering it."""
        _write_fixture_app(fixture_repo, "fixture_plugin")
        _write_manifest(
            fixture_repo,
            _base_manifest(
                user_ingress={
                    "app": "fixture_plugin.app:does_not_exist",
                    "required_group": "founder",
                },
            ),
        )

        with pytest.raises(ConformanceCheckError) as exc_info:
            host_mount.run(ConformanceContext(repo_root=fixture_repo))
        assert "fixture_plugin.app:does_not_exist" in str(exc_info.value)

    def test_a_nonexistent_module_ref_also_fails_naming_the_ref(self, fixture_repo):
        _write_fixture_app(fixture_repo, "fixture_plugin")
        _write_manifest(
            fixture_repo,
            _base_manifest(
                user_ingress={
                    "app": "fixture_plugin.no_such_module:app",
                    "required_group": "founder",
                },
            ),
        )

        with pytest.raises(ConformanceCheckError, match="fixture_plugin.no_such_module:app"):
            host_mount.run(ConformanceContext(repo_root=fixture_repo))

    def test_a_declared_route_that_never_reaches_the_forwarder_fails(
        self, fixture_repo, monkeypatch
    ):
        """Simulates a mounting-order/path-template bug: the manifest declares
        a route, but the host's own forwarder never recognises it (here,
        because the manifest's own route path is inconsistent with the table
        it authorises isn't relevant — instead we substitute a plugin app that
        would 404 given the same route, proving the check doesn't just trust
        the manifest without exercising the real host)."""
        _write_fixture_app(fixture_repo, "fixture_plugin")
        _write_manifest(
            fixture_repo,
            _base_manifest(
                user_ingress={"app": "fixture_plugin.app:app", "required_group": "founder"},
                api_routes=[
                    {"method": "GET", "path": "/widgets", "table": "widgets", "operation": "list"}
                ],
            ),
        )

        # Force the real forwarder to never recognise the declared route by
        # making DeclaredRouteForwarder's own registration see an empty
        # api_routes set, while host_mount still believes (from the manifest)
        # that one route was declared -- reproduces "declared but not
        # actually reachable" without hand-rolling a second forwarder.
        #
        # Patched on `plugin_host.mount` itself, not on `host_mount`:
        # `host_mount.run()` imports `build_host` with a fresh `from
        # plugin_host.mount import ... build_host` on every call (see its own
        # docstring/lazy-import comment), so the name is looked up on the real
        # module at call time and is never a module-level attribute of
        # `host_mount` to monkeypatch directly.
        import plugin_host.mount as real_mount

        original_build_host = real_mount.build_host

        def _build_host_dropping_routes(mounted_plugins, **kwargs):
            stripped = [
                real_mount.MountedPlugin(
                    name=p.name,
                    app=p.app,
                    required_group=p.required_group,
                    admin_app=p.admin_app,
                    admin_required_group=p.admin_required_group,
                    api_routes=(),
                    user_frontend_dir=p.user_frontend_dir,
                )
                for p in mounted_plugins
            ]
            return original_build_host(stripped, **kwargs)

        monkeypatch.setattr(real_mount, "build_host", _build_host_dropping_routes)

        with pytest.raises(ConformanceCheckError, match="did not resolve to a forwardable mount"):
            host_mount.run(ConformanceContext(repo_root=fixture_repo))
