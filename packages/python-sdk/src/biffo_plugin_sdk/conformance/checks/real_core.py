"""#1523 seam 3 — real Core under the harness.

**Not yet implemented, and deliberately not scheduled.** Gated on spike #1522
(Core under uvicorn against harness Postgres with a dev-mode token minter),
which is `OPEN`, carries zero comments and `fleet:hold` as of the plan this
milestone implements (`docs/implementation/0007-plugin-verify-conformance/
README.md`, "Blocked items"). Filing a done-condition for this seam before the
spike reports would mean inventing the very thing the spike exists to
establish.

This module exists — with no `run` — so `--list-checks` names this seam
rather than letting the denominator silently shrink (biffo-template#1924's own
done-when: `1 implemented, 4 not-implemented`).
"""

from __future__ import annotations

CHECK_NAME = "real_core"
IMPLEMENTED = False
NOTE = "blocked on spike #1522 (Core-in-a-box feasibility) -- not yet planned"
