"""Real-execution conformance checks for a Biffo plugin (biffo-template#1523/#1924).

`biffo plugin verify` (`cli/src/lib/plugin-verify/`, in the template's `@biffo/cli`)
is the composition: it raises a real Postgres via the already-distributed
`scripts/pg-test-db.sh`, then shells out to this package twice against the same
database. This package owns the checks themselves, so a plugin repo's CI gains
one line (`sh scripts/biffo.sh plugin verify`) instead of a copy of the harness —
see the plan's "the checks ship in the packages, not in the repos"
(`docs/implementation/0007-plugin-verify-conformance/README.md`).

**Discovery is a glob, not a registry.** `discover_checks()` walks
`biffo_plugin_sdk.conformance.checks` the same way `scripts/verify.sh`'s
`pg_test_modules()` walks for `test_*_pg.py`: every module in the package is a
check, found by looking at what is actually there rather than a hand-maintained
list a new check could forget to join. A check that has no module here yet
(gated on work that has not landed — see each stub's own docstring) still gets a
module: `IMPLEMENTED = False` with no `run`, so `--list-checks` names all five
#1523 seams and the denominator can never silently shrink to "1 of 1".

**Fails closed on empty discovery, deliberately.** Zero modules under `checks/`
is not "nothing to check" — every seam #1523 names has a module here, even the
ones with no `run` yet — so an empty result means the package itself is broken
(a bad install, a missing file), and callers (`__main__.py`) must treat it as a
failure, not a vacuous pass (the skeleton's own `guard-self-test-wiring.sh`
wording; see `docs/implementation/0007-plugin-verify-conformance/README.md`).
"""

from __future__ import annotations

import importlib
import pkgutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from . import checks as _checks_pkg

__all__ = [
    "CheckSpec",
    "ConformanceCheckError",
    "ConformanceContext",
    "discover_checks",
]


@dataclass(frozen=True)
class ConformanceContext:
    """What a check needs to run against the repo it was invoked from.

    ``dsn`` is ``None`` for a check (like ``host_mount``) that has no use for a
    database; a check that does need one (``migrations``, M3) asserts it is
    non-empty itself rather than this shared context guessing which checks
    care.
    """

    repo_root: Path
    dsn: str | None = None


class ConformanceCheckError(Exception):
    """Raised by a check's ``run()`` for an assertion failure worth naming to
    the operator directly — as opposed to an unexpected crash, which
    ``__main__.py`` reports separately so a check's own bug is never confused
    with the thing it was checking.
    """


@dataclass(frozen=True)
class CheckSpec:
    """One discovered `checks/*.py` module, described rather than imported blind.

    ``run`` is ``None`` for a declared-but-not-yet-implemented seam — `__main__`
    skips those when actually running, but `--list-checks` still names them
    (biffo-template#1924's own done-when: ``1 implemented, 4 not-implemented``).
    """

    name: str
    implemented: bool
    note: str
    run: Callable[[ConformanceContext], None] | None


def discover_checks() -> list[CheckSpec]:
    """Every module under `biffo_plugin_sdk.conformance.checks`, sorted by name.

    Each module must declare ``CHECK_NAME: str`` and ``IMPLEMENTED: bool``, and
    an implemented one must declare ``run(ctx: ConformanceContext) -> None``
    (raising :class:`ConformanceCheckError` on a failed assertion). A
    not-implemented module may omit ``run`` entirely — it exists only to be
    named by ``--list-checks``, per this module's own docstring.
    """
    specs: list[CheckSpec] = []
    for info in sorted(pkgutil.iter_modules(_checks_pkg.__path__), key=lambda m: m.name):
        module = importlib.import_module(f"{_checks_pkg.__name__}.{info.name}")
        implemented = bool(module.IMPLEMENTED)
        specs.append(
            CheckSpec(
                name=module.CHECK_NAME,
                implemented=implemented,
                note=getattr(module, "NOTE", ""),
                run=getattr(module, "run", None) if implemented else None,
            )
        )
    return specs
