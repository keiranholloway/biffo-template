"""Placeholder ASGI app backing this plugin's `admin_ingress` surface (ADR-0021).

`biffo.plugin.json`'s `admin_ingress.app` names this module's `app` object. The
**shared plugin host** imports it, provides the Lambda entry, and mounts it at
`/api/v1/plugins/<name>/admin/*`, enforcing `admin_ingress.required_group`
(ADR-0011) before a request ever reaches here — see `user_app.py`'s docstring
for why this file does no auth of its own.

**This is also `web-admin/`'s one reader (biffo-template#2008).** The skeleton
shipped a full admin frontend at `web-admin/` that no manifest field referenced
— an orphan directory nothing would ever build or serve. `AdminIngress` in the
SDK is explicitly "the plugin's admin-gated API and optional static UI bundle":
unlike `user_frontend` (a separate declarative `dir`, served directly by the
host with no plugin code involved), the admin surface's static bundle is served
*by the app this field names* — `web-admin/`'s own `vite.config.ts` already
targets exactly this mount point (`base:
'/api/v1/plugins/example-plugin/admin/'`).

`web-admin/dist/` is the Vite build output — gitignored, and not built by this
repo's CI (that wiring is follow-up work; #2008's scope is declaring the
surfaces, not shipping the built bundle, mirroring `user_frontend.dir` above
pointing at `web/dist` before that directory exists either — see #2009). The
mount below is skipped when `dist/` is absent, so a fresh checkout and `pytest`
need no build step and no edits (this issue's "done when" criterion) — once
`web-admin` is built, dropping its `dist/` in place is enough to serve it, with
no further code change.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="example-plugin admin ingress")

# src/example_plugin/admin_app.py -> src/example_plugin -> src -> repo root
# (plugin root, where web-admin/ lives alongside biffo.plugin.json).
WEB_ADMIN_DIST = Path(__file__).resolve().parent.parent.parent / "web-admin" / "dist"


@app.get("/ping")
def ping() -> dict[str, str]:
    """Identifies the plugin, so the mount can be proven real rather than guessed at."""
    return {"plugin": "example-plugin", "surface": "admin_ingress"}


if WEB_ADMIN_DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(WEB_ADMIN_DIST), html=True), name="web-admin")
