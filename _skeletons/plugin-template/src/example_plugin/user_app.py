"""Placeholder ASGI app backing this plugin's `user_ingress` surface (ADR-0021).

`biffo.plugin.json`'s `user_ingress.app` names this module's `app` object. The
**shared plugin host** imports it, provides the Lambda entry, and mounts it at
`/api/v1/plugins/<name>/*` — a plugin declaring `user_ingress` ships no Lambda
handler and no infrastructure of its own for this surface (see `terraform/`:
nothing here needs a per-plugin resource).

**No auth in this file, on purpose.** The host enforces `user_ingress.required_group`
(ADR-0011) before a request ever reaches a mounted app — see
`biffo_plugin_sdk.user_serving`'s module docstring: its `require_group` dependency
is only for an `isolated: true` plugin running in its own Lambda outside the
shared host. Adding a second check here would be redundant at best and a
divergent enforcement path at worst.

This is intentionally a placeholder (biffo-template#2008): one route that
identifies the plugin, enough to prove the mount is real, not enough to be
mistaken for a feature. Replace it with your own user-facing routes.
"""

from __future__ import annotations

from fastapi import FastAPI

app = FastAPI(title="example-plugin user ingress")


@app.get("/ping")
def ping() -> dict[str, str]:
    """Identifies the plugin, so the mount can be proven real rather than guessed at."""
    return {"plugin": "example-plugin", "surface": "user_ingress"}
