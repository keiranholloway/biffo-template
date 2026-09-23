"""#1523 seam 1 — migration transitions against real Postgres.

**Permanently not implemented here, by design.** biffo-template#2061 asked
whether the published `biffo-plugin-sdk` should ship a Postgres client so
plugin repos could run the #1511 transitions themselves, or whether they
should stay on Core's side of the ADR-0002 line. The issue's decision memo
laid out three options — extract the generator into the SDK behind a new
`conformance` extra (a one-way door: an accepted-ADR exception, a published
package shipping a DB client, and the generator becoming semver-bound public
API), keep the transitions in Core with this check reporting a permanent,
visible gap, or park behind spike #1522 (real Core under the harness). The
owner decided **Option B**: keep the transitions in Core exactly as they run
today.

**Status.** The three transitions run against real Postgres in Core, as
`services/api/tests/test_plugin_migration_transitions_pg.py`. That is where
the generator lives, and #1513's fail-first (the generator re-created all six
tables; the downgrade dropped five tables of data) is demonstrated there,
guarding the #1511 bug class on every Core CI run. Plugin-repo coverage for
this specific seam is intentionally out of scope: a plugin-specific manifest
shape isn't caught here unless it also breaks Core's fixture, or until an
instance actually generates the migration. That trade was made deliberately,
not left unresolved.

This module exists — with no `run` — so `--list-checks` names this seam
rather than letting the denominator silently shrink (biffo-template#1924's
own done-when: `1 implemented, 4 not-implemented`).
"""

from __future__ import annotations

CHECK_NAME = "migrations"
IMPLEMENTED = False
NOTE = (
    "biffo-template#2061 (Option B, settled) -- migration transitions (#1511 "
    "fixture) are verified in Core's real-Postgres lane; this seam stays "
    "not-implemented here by design, not pending extraction"
)
