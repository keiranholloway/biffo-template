"""`python -m biffo_plugin_sdk.conformance` — the process `biffo plugin verify`
(`cli/src/lib/plugin-verify/`) shells out to, twice, against the same
database (biffo-template#1924).

This module is deliberately the ONLY place that knows how to run or list the
checks in `biffo_plugin_sdk.conformance.checks` — the CLI's job is composition
(raise Postgres, invoke this twice, react to the exit code), not a second copy
of "what a check is" (see the parent package's docstring for why discovery
lives here and not in a registry file).

Exit codes: `0` every implemented check passed; `1` a check failed, or
discovery itself found nothing to run (an empty discovery is not a vacuous
pass — see `discover_checks`'s docstring).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import CheckSpec, ConformanceCheckError, ConformanceContext, discover_checks

_EMPTY_DISCOVERY_MESSAGE = (
    "biffo plugin verify: discovered zero conformance checks under "
    "biffo_plugin_sdk.conformance.checks -- this is a broken install, not an empty "
    "scope (an empty discovery is not a vacuous pass)."
)


def _print_catalog(checks: list[CheckSpec]) -> None:
    for check in checks:
        state = "implemented" if check.implemented else "not-implemented"
        note = f"  ({check.note})" if check.note else ""
        print(f"{check.name:<20} {state}{note}", flush=True)
    implemented = sum(1 for check in checks if check.implemented)
    print(f"{implemented} implemented, {len(checks) - implemented} not-implemented", flush=True)


def list_checks() -> int:
    checks = discover_checks()
    if not checks:
        print(_EMPTY_DISCOVERY_MESSAGE, file=sys.stderr, flush=True)
        return 1
    _print_catalog(checks)
    return 0


def run_checks(repo_root: Path, dsn: str | None) -> int:
    checks = discover_checks()
    if not checks:
        print(_EMPTY_DISCOVERY_MESSAGE, file=sys.stderr, flush=True)
        return 1

    implemented = [check for check in checks if check.implemented]
    if not implemented:
        print(
            "biffo plugin verify: zero of the declared checks are implemented yet "
            f"(0/{len(checks)}).",
            file=sys.stderr,
            flush=True,
        )
        return 1

    ctx = ConformanceContext(repo_root=repo_root, dsn=dsn)
    failures: list[str] = []
    for check in implemented:
        print(f"--- {check.name} ---", flush=True)
        assert check.run is not None  # guaranteed by discover_checks for implemented=True
        try:
            check.run(ctx)
        except ConformanceCheckError as exc:
            print(f"FAIL {check.name}: {exc}", file=sys.stderr, flush=True)
            failures.append(check.name)
        except Exception as exc:  # noqa: BLE001 -- a check's own bug must not crash the runner
            print(f"FAIL {check.name}: unexpected error: {exc}", file=sys.stderr, flush=True)
            failures.append(check.name)

    if failures:
        print(
            f"biffo plugin verify: {len(failures)}/{len(implemented)} check(s) failed: "
            f"{', '.join(failures)}",
            file=sys.stderr,
            flush=True,
        )
        return 1

    print(f"biffo plugin verify: {len(implemented)}/{len(implemented)} check(s) passed", flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m biffo_plugin_sdk.conformance")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser(
        "list-checks", help="Print every declared #1523 seam and its implemented state"
    )

    run_parser = subparsers.add_parser("run", help="Run every implemented conformance check once")
    run_parser.add_argument(
        "--repo-root", default=".", help="Plugin repo root to check (default: cwd)"
    )
    run_parser.add_argument(
        "--dsn", default=None, help="Postgres DSN a check may use (default: none)"
    )

    args = parser.parse_args(argv)

    if args.command == "list-checks":
        return list_checks()
    if args.command == "run":
        return run_checks(Path(args.repo_root).resolve(), args.dsn)
    return 2  # unreachable -- argparse enforces `required=True` on the subparser


if __name__ == "__main__":
    raise SystemExit(main())
