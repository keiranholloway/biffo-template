"""CLI entrypoint invoked by the Node CLI (``biffo plugin install``/``upgrade``/
``sync-migrations``) to generate real, git-committed Alembic migration files
for installed plugins' tables.

Thin wrapper around ``api.migrations.plugin_migrations.sync_plugin_migrations``
— reused as-is, just pointed at the real, git-tracked ``versions/`` directory
instead of the ephemeral ``/tmp`` copy ``main.py``'s ``_run_db_init`` used to
make on every Lambda invocation (removed — see that function and
``plugin_migrations.sync_plugin_migrations``'s docstring for the incident this
fixes).

Contract with callers:
- Prints one absolute path per newly generated migration file to stdout, one
  per line. Prints nothing if every named plugin's migration already existed
  or the plugin declares no tables (both are legitimate no-ops, not errors).
- Exit code 0 on success (including the "nothing to do" case).
- Exit code 1, with a message on stderr, if an explicitly-named --plugin
  isn't discoverable under --services-root, or if
  ``generate_migration_for_plugin`` refuses to guess at a column-level
  change (issue #1539) — an already-migrated table with a column removed,
  retyped, nullability-changed, or whose existing columns can't be
  determined. The message is the ``ValueError``'s own text, not a raw
  traceback: the Node CLI (``cli/src/adapters/plugin-migrations/index.ts``)
  surfaces stderr verbatim to the operator, and a traceback would bury the
  actionable "table X, column Y" detail under Python frames.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from api.migrations.plugin_migrations import sync_plugin_migrations  # noqa: E402
from api.plugins import discover_plugin_manifests  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--services-root",
        required=True,
        type=Path,
        help="Directory containing services/*/",
    )
    parser.add_argument(
        "--versions-dir",
        required=True,
        type=Path,
        help="Alembic versions/ directory to write generated migrations into",
    )
    parser.add_argument(
        "--plugin",
        action="append",
        default=None,
        metavar="NAME",
        help="Restrict to this plugin name; repeatable. Default: all discovered plugins.",
    )
    args = parser.parse_args(argv)

    if args.plugin:
        discovered = {m.get("name") for m in discover_plugin_manifests(args.services_root)}
        missing = set(args.plugin) - discovered
        if missing:
            print(
                f"No installed plugin manifest found for: {', '.join(sorted(missing))} "
                f"under {args.services_root}",
                file=sys.stderr,
            )
            return 1

    try:
        generated = sync_plugin_migrations(
            args.versions_dir,
            services_root=args.services_root,
            only=set(args.plugin) if args.plugin else None,
        )
    except ValueError as exc:
        # generate_migration_for_plugin refuses rather than guesses at a
        # column-level change it can't safely handle (issue #1539) — surface
        # its own message, not a traceback (see module docstring).
        print(str(exc), file=sys.stderr)
        return 1

    for path in generated:
        print(path.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
