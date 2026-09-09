"""Pins the three platform surfaces `biffo.plugin.json` declares (biffo-template#2008).

Before this, `_skeletons/plugin-template` declared none of `user_ingress`,
`admin_ingress` or `user_frontend` — the platform already serves all three
(the working reference is `keiranholloway/biffo-plugin-ideation`'s manifest),
but every scaffolded plugin started life exposing none of them. This test
guards three things at once:

1. the manifest actually validates against the SDK's real `PluginManifest`
   (`extra="forbid"`, so a typo in a block's keys fails loudly rather than
   silently dropping the surface — see `README.md`'s "Manifest validation"
   section for why that model, not `registry-schema.json`, is authoritative);
2. each `*_ingress.app` reference actually resolves to a real, importable ASGI
   app — not merely a string that looks right; and
3. each placeholder app answers with something that identifies the plugin,
   so the mount is real rather than guessed at (this issue's own "done when").
"""

from __future__ import annotations

import importlib

from biffo_plugin_sdk.plugin import load_manifest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from example_plugin.manifest import MANIFEST_PATH


def _resolve_app(app_ref: str) -> FastAPI:
    """Resolve a manifest `*_ingress.app` string ('<module>:<attr>') the same
    way the shared plugin host would — a plain dynamic import, not a literal
    reference to this test's own imports, so a manifest string that drifted
    from the real module path would be caught here rather than passing by
    coincidence."""
    module_name, _, attr = app_ref.partition(":")
    module = importlib.import_module(module_name)
    return getattr(module, attr)


class TestManifestDeclaresAllThreeSurfaces:
    def test_manifest_validates_and_declares_user_ingress(self) -> None:
        manifest = load_manifest(MANIFEST_PATH)
        assert manifest.user_ingress is not None
        assert manifest.user_ingress.required_group == "founder"
        assert manifest.user_ingress.app == "example_plugin.user_app:app"

    def test_manifest_declares_admin_ingress(self) -> None:
        manifest = load_manifest(MANIFEST_PATH)
        assert manifest.admin_ingress is not None
        assert manifest.admin_ingress.required_group == "admin"
        assert manifest.admin_ingress.app == "example_plugin.admin_app:app"

    def test_manifest_declares_user_frontend(self) -> None:
        manifest = load_manifest(MANIFEST_PATH)
        assert manifest.user_frontend is not None
        assert manifest.user_frontend.dir == "web/dist"
        assert manifest.user_frontend.required_group == "founder"

    def test_ui_components_no_longer_point_at_a_dead_admin_path(self) -> None:
        """The old `/admin/example-plugin` paths matched none of the three real
        surfaces (this issue's own finding) — pin that they now sit under the
        portal's real installed-plugin route instead."""
        manifest = load_manifest(MANIFEST_PATH)
        paths = {c.path for c in manifest.ui_components}
        assert paths == {
            "/admin/plugins/example-plugin",
            "/admin/plugins/example-plugin/widgets",
        }


class TestIngressAppsResolveAndIdentifyThePlugin:
    def test_user_ingress_app_resolves_and_answers(self) -> None:
        manifest = load_manifest(MANIFEST_PATH)
        assert manifest.user_ingress is not None
        app = _resolve_app(manifest.user_ingress.app)

        response = TestClient(app).get("/ping")

        assert response.status_code == 200
        assert response.json() == {"plugin": "example-plugin", "surface": "user_ingress"}

    def test_admin_ingress_app_resolves_and_answers(self) -> None:
        manifest = load_manifest(MANIFEST_PATH)
        assert manifest.admin_ingress is not None
        app = _resolve_app(manifest.admin_ingress.app)

        response = TestClient(app).get("/ping")

        assert response.status_code == 200
        assert response.json() == {"plugin": "example-plugin", "surface": "admin_ingress"}


class TestAdminIngressWebAdminOrphanResolution:
    """`web-admin/` had no manifest field referencing it (this issue's own
    finding). `admin_app.py` is now its one reader — these pin that the
    reference is real (the directory `admin_app` looks for is exactly
    `web-admin/`, not a typo'd sibling) and that a repo state with no built
    `dist/` yet (true of this skeleton and every fresh checkout, since `dist/`
    is gitignored and nothing builds it here — see admin_app.py's docstring)
    still imports and serves cleanly rather than raising at import time.
    """

    def test_web_admin_dist_path_points_at_the_real_directory(self) -> None:
        from example_plugin.admin_app import WEB_ADMIN_DIST

        assert WEB_ADMIN_DIST.parent.name == "web-admin"
        assert WEB_ADMIN_DIST.name == "dist"
        assert WEB_ADMIN_DIST.parent.is_dir(), "web-admin/ itself must still exist"

    def test_static_mount_is_skipped_when_dist_is_absent(self) -> None:
        from example_plugin.admin_app import WEB_ADMIN_DIST, app

        assert not WEB_ADMIN_DIST.is_dir(), (
            "this test asserts the no-build-yet behaviour; if dist/ has been "
            "built locally, the skip path this test pins is not being exercised"
        )
        response = TestClient(app).get("/some/never-built/asset.js")
        assert response.status_code == 404
