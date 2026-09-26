"""#1523 seam 3 — real Core under the harness.

**Composition-owned: run by the CLI, not by this package.** Spike #1522 established
that Core boots under plain uvicorn against harness Postgres with a dev-minted token,
and `biffo dev up` (#1525) is that composition. `biffo plugin verify` runs the SAME
composition (`cli/src/lib/plugin-compose/compose-stack.ts`, via `runCompositionCheck`
— #2105) after the conformance passes, so a plugin that does not start under real
Core is red in the same lane. It lives in the CLI because starting Core and the
shared host is process composition, which the CLI already owns; a Python copy of it
would be the second implementation #2105 exists to prevent.

This module has no `run`, deliberately: `conformance run` has nothing to execute
here. It exists so `--list-checks` names this seam rather than letting the
denominator silently shrink, and `IMPLEMENTED` stays `False` because that flag
means "`conformance run` executes it".
"""

from __future__ import annotations

CHECK_NAME = "real_core"
IMPLEMENTED = False
NOTE = (
    "composition-owned: run by `biffo plugin verify` via plugin-compose/compose-stack "
    "(#2105), not by `conformance run`"
)
