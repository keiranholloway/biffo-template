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

This module exists — with no `run` — so `--list-checks` names this seam
rather than letting the denominator silently shrink to "1 of 1"
(biffo-template#1924's own done-when: `1 implemented, 4 not-implemented`).
"""

from __future__ import annotations

CHECK_NAME = "migrations"
IMPLEMENTED = False
NOTE = (
    "M3 / biffo-template#1925 -- migration transitions against real Postgres, "
    "#1511 as a permanent fixture"
)
