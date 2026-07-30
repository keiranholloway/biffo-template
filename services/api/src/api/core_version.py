"""The core version this deployment is running, baked in at package time (#648).

## Why a generated module rather than a runtime lookup

#648 asked for a runtime walk up the filesystem looking for `core.version`. That
file is a fossil since #423 — on `biffo-platform` it reads `0.41.17` against an
authority of `0.181.0` — so `/health` would have reported a version 140 releases
behind, and #842 now deletes it, after which the walk would find nothing.

Resolving at **build** time instead makes "we could not tell" a red build rather
than a `/health` response quietly reading `unknown` months later.
`scripts/resolve-core-version.sh` reads `biffo.core.json` in an instance or the
highest `core-v*` tag in the template, fails loudly if it can find neither, and the
packaging step writes the answer to `_core_version.py` beside this module.

## Why the import is relative and guarded

Relative because the import root differs between contexts: tests import `api.*`
while the Lambda handler is `src.api.main.lambda_handler`, so `api._core_version`
resolves in one and not the other. `from ._core_version import ...` works in both.

Guarded because `_core_version.py` is generated and git-ignored, so it is genuinely
absent in a checkout, in an editor, and in the test suite. That is not a failure —
a working tree has no deployed version to report. `/health` must never error
(#648), so the absence reads as `unknown` rather than raising.

The distinction worth keeping: `unknown` here means "not built from a package",
which is normal. It does **not** mean "the build could not determine a version" —
that case cannot reach this module, because the build fails first.
"""

from __future__ import annotations

#: Emitted when this is not a packaged deployment — a checkout, an editor, a test.
UNKNOWN_CORE_VERSION = "unknown"


def core_version() -> str:
    """The core version baked in at package time, or ``"unknown"`` in a checkout.

    Not cached: the import itself is the cache. Python caches the module after the
    first successful import, and the failing case is a single `ImportError` per
    process — cheaper than the `lru_cache` the issue proposed, and with one less
    piece of state to reason about on a cold start.
    """
    try:
        # pyright cannot resolve this and is right not to: the module does not
        # exist in a checkout, which is the whole design. Suppressed narrowly
        # rather than by config so the reason travels with the line.
        from ._core_version import CORE_VERSION  # pyright: ignore[reportMissingImports]
    except ImportError:
        return UNKNOWN_CORE_VERSION
    return CORE_VERSION or UNKNOWN_CORE_VERSION
