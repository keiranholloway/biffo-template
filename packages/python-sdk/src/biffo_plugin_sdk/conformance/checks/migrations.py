"""#1523 seam 1 — migration transitions against real Postgres.

**Not yet implemented.** Scoped as M3 (biffo-template#1925), sequenced after
this milestone (M2, #1924) because both write into this same `conformance/`
package (read-set collision, not just a logic dependency — see the plan's
"Parallelism" section).

M3's job: fresh install AND upgrade-onto-existing-installation against a real
database, asserting the generated migration is a delta and its downgrade
inverts only that delta — #1511's exact failing case (the generator
re-created all six tables; the downgrade dropped five tables of data) becomes
a permanent fixture here, fail-first against PR #1513 reverted.

**Status after #1925.** The three transitions now run against real Postgres
in Core, as `services/api/tests/test_plugin_migration_transitions_pg.py`.
That is where the generator lives, and #1513's fail-first is demonstrated
there. They cannot run here yet: the generator and the `plugin_table` model
still need extracting into this package, and applying a migration from this
package needs a DB client, which TID251 (ADR-0002) bans outside
`services/api/`. Both are split out as biffo-template#2061.

This module exists — with no `run` — so `--list-checks` names this seam
rather than letting the denominator silently shrink to "1 of 1"
(biffo-template#1924's own done-when: `1 implemented, 4 not-implemented`).
"""

from __future__ import annotations

CHECK_NAME = "migrations"
IMPLEMENTED = False
NOTE = (
    "biffo-template#2061 -- migration transitions (#1511 fixture) run in Core's "
    "pg lane today; needs the generator extracted into this SDK to run here"
)
