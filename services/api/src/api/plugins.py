"""Discovers installed plugin manifests.

Per ADR-0003 section 2, an installed plugin lives in its own directory under
``services/<name>/`` with a ``biffo.plugin.json`` manifest at its root (the
CLI clones it there at ``biffo plugin install`` time). This module scans for
those manifests so the Core API can:

- list installed plugins with their table schemas (``routers/admin/plugins.py``)
- auto-generate their table migrations (``migrations/plugin_migrations.py``'s
  ``sync_plugin_migrations``, called from ``main.py``'s ``_run_db_init``)

The Core API Lambda artifact is packaged from ``services/api/`` alone (see
``.github/workflows/deploy-app.yml``), so a plugin's full source tree is
never bundled into the deployed Lambda — but each installed plugin's
``biffo.plugin.json`` manifest *is*: the packaging step copies every
``services/*/biffo.plugin.json`` into the zip under ``services/<name>/``,
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


def discover_plugin_manifests(
    services_root: Path | None = None,
) -> list[dict[str, Any]]:
    """Scan ``services/*/biffo.plugin.json`` for installed plugin manifests.

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

    manifests: list[dict[str, Any]] = []
    for manifest_path in sorted(root.glob("*/biffo.plugin.json")):
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
