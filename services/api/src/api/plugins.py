"""Discovers installed plugin manifests.

Per ADR-0003 section 2, an installed plugin lives in its own directory with a
``biffo.plugin.json`` manifest at its root. There are two such locations,
because there are two distribution channels (issue #243):

- ``services/_plugins/<name>/`` — **first-party** plugins, shipped in the
  template and template-owned in ``core-manifest.json``, so ``biffo core
  upgrade`` carries them into instances automatically.
- ``services/<name>/`` — **third-party / user** plugins, installed from the
  marketplace registry by ``biffo plugin install`` into the user-owned
  ``services/`` subtree, where an upgrade will never overwrite them.

Both are scanned, so where a plugin lives affects who owns it, never whether
it is discovered. This module scans for those manifests so the Core API can:

- list installed plugins with their table schemas (``routers/admin/plugins.py``)
- generate their table migrations at CLI time (``migrations/plugin_migrations.py``'s
  ``sync_plugin_migrations``, called from ``scripts/generate_plugin_migrations.py``
  by ``biffo plugin install``/``upgrade``/``sync-migrations``)

The Core API Lambda artifact is packaged from ``services/api/`` alone (see
``.github/workflows/deploy-app.yml``), so a plugin's full source tree is
never bundled into the deployed Lambda — but each installed plugin's
``biffo.plugin.json`` manifest *is*: the packaging step copies every
``services/*/biffo.plugin.json`` **and** ``services/_plugins/*/biffo.plugin.json``
into the zip, flattened to ``services/<name>/`` (the deployed layout is keyed
on plugin *name*, not on the source channel — only this scan needs to know
about both),
and ``BIFFO_PLUGIN_SERVICES_ROOT`` (set by Terraform to ``/var/task/services``,
where AWS extracts the zip) points this scan at them. Only the manifest
travels — the generic CRUD layer (``routing/plugin_router.py``) synthesizes
routes and SQLAlchemy models from the manifest's declared ``tables``/
``api_routes`` alone, so a plugin's own Python source is never needed here.
A plugin's non-CRUD code (event subscriptions, custom logic) still runs in
its own separate deployment, outside the Core API Lambda entirely.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from aws_lambda_powertools import Logger

from .config import settings

logger = Logger()

# This file lives at services/api/src/api/plugins.py — parents[3] from here
# is the monorepo's services/ directory (api/src/api -> api/src -> api ->
# services).
_DEFAULT_SERVICES_ROOT = Path(__file__).resolve().parents[3]

# Subdirectory of services/ holding first-party (template-owned) plugins.
# See core-manifest.json's note and ADR-0003 for why the two channels exist.
FIRST_PARTY_PLUGINS_DIR = "_plugins"


def discover_plugin_manifests(
    services_root: Path | None = None,
) -> list[dict[str, Any]]:
    """Scan for installed plugin manifests in both plugin locations.

    Globs ``*/biffo.plugin.json`` (third-party/user plugins, user-owned) and
    ``_plugins/*/biffo.plugin.json`` (first-party plugins, template-owned).

    Args:
        services_root: Directory containing one subdirectory per service
            (defaults to the monorepo's ``services/`` directory, or the
            ``BIFFO_PLUGIN_SERVICES_ROOT`` env var if set).

    Returns:
        Parsed manifest dicts, in a deterministic (sorted by path) order.
        A manifest that fails to parse is logged and skipped rather than
        raising — one broken plugin must not take down discovery (or Core
        API startup, via sync_plugin_migrations) for every other plugin.
    """
    root = services_root or _configured_services_root()
    if not root.is_dir():
        return []

    # ``_plugins`` is a *container* for first-party plugins, not a plugin
    # itself, so a manifest sitting directly in it is not a plugin and is
    # excluded — only its children are scanned.
    manifest_paths = sorted(
        [
            p
            for p in root.glob("*/biffo.plugin.json")
            if p.parent.name != FIRST_PARTY_PLUGINS_DIR
        ]
        + list(root.glob(f"{FIRST_PARTY_PLUGINS_DIR}/*/biffo.plugin.json"))
    )

    manifests: list[dict[str, Any]] = []
    for manifest_path in manifest_paths:
        try:
            manifests.append(json.loads(manifest_path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning(
                f"Skipping unreadable plugin manifest {manifest_path}: {exc}"
            )
    return manifests


def _configured_services_root() -> Path:
    override = settings.plugin_services_root
    return Path(override) if override else _DEFAULT_SERVICES_ROOT
