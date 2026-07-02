"""Discovers bundled DDL import directories.

A DDL import is a directory of plain `.sql` files, vendored into the project
checkout under `db/imports/<name>/` by `biffo data import` (the CLI clones a
local directory or a GitHub repo and copies only its `*.sql` files there,
mirroring how `biffo plugin install` vendors a plugin's source into
`services/<name>/` -- see ADR-0003 and this feature's own
docs/ADR/0005-ddl-import-module.md).

The Core API Lambda artifact is packaged from `services/api/` alone (see
`.github/workflows/deploy-app.yml`), so -- exactly like plugin manifests
(`api.plugins`) -- `db/imports/*/*.sql` needs its own bundling step: the
packaging step copies every `db/imports/*/*.sql` into the zip under
`db/imports/<name>/`, and `BIFFO_DDL_IMPORT_ROOT` (set by Terraform to
`/var/task/db/imports`, where AWS extracts the zip) points this scan at them.

Applying the files this module discovers -- computing checksums, tracking
which have already run, and executing their raw SQL against Postgres on a
single persistent connection (session-level state like `SET search_path` set
by an early file must persist for later files in the same run) -- is
`main.py`'s `_run_ddl_import`, not this module. This module only ever reads
the filesystem.
"""

from __future__ import annotations

from pathlib import Path

from aws_lambda_powertools import Logger

from .config import settings

logger = Logger()

# This file lives at services/api/src/api/ddl_import.py — parents[4] from
# here is the monorepo root (api/src/api -> api/src -> api -> services ->
# <root>), sibling to services/. Only meaningful in a full monorepo checkout
# (local dev, CI) — see the module docstring for the deployed-Lambda path.
_DEFAULT_DDL_IMPORT_ROOT = Path(__file__).resolve().parents[4] / "db" / "imports"


def discover_ddl_import_dirs(root: Path | None = None) -> list[str]:
    """List available DDL import names — subdirectories of `root` containing
    at least one `.sql` file.

    Args:
        root: Directory containing one subdirectory per import (defaults to
            the monorepo's `db/imports/` directory, or the
            `BIFFO_DDL_IMPORT_ROOT` env var if set).

    Returns:
        Import names, sorted. A subdirectory that can't be listed is logged
        and skipped rather than raising — one broken entry must not take
        down discovery for every other import.
    """
    root = root or _configured_ddl_import_root()
    if not root.is_dir():
        return []

    names: list[str] = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue
        try:
            has_sql = any(entry.glob("*.sql"))
        except OSError as exc:
            logger.warning(f"Skipping unreadable DDL import directory {entry}: {exc}")
            continue
        if has_sql:
            names.append(entry.name)
    return names


def list_sql_files(import_dir: Path) -> list[Path]:
    """Sorted `.sql` files directly under `import_dir` (non-recursive).

    Sort order is apply order — this is why real DDL import sources use a
    numeric-prefix naming convention (`000_`, `001_`, ...), the same
    convention Alembic's own `versions/` directory relies on.
    """
    return sorted(import_dir.glob("*.sql"))


def _configured_ddl_import_root() -> Path:
    override = settings.ddl_import_root
    return Path(override) if override else _DEFAULT_DDL_IMPORT_ROOT
