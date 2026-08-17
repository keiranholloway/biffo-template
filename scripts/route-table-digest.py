#!/usr/bin/env python3
"""Compute core's route-table digest for `.well-known/route-revision.json` (#1604).

## What this solves

A sibling's deploy is structurally incapable of seeing core's deploy state:
`resolve-environment -> deploy-infra -> deploy-app` runs with no step that
reads anything about core, and its only post-deploy proof is its OWN Lambda
health and its OWN CDN route. Merge ordering does not fix this either — in
the recorded incident the core PR had already merged and the core deploy
simply sat in the runner queue while the sibling went live first, serving
requests against routes core had not shipped yet.

## Why a digest, not the surface

`/openapi.json` is deliberately 401-gated and stays that way — the estate has
already decided the core API's live route surface is not public. This script
never calls that endpoint and never writes the route list anywhere public. It
reduces the route table to two values a sibling can act on without learning
what changed:

  - `hash`   — sha256 of the sorted `METHOD path` list. Proves the table is
               DIFFERENT from some previous observation. On its own this
               cannot support "core is at or past the revision I need": a
               hash tells you "changed", never "newer" — two deploys could
               hash differently in either direction, or hash the same by
               coincidence after an unrelated change reverted.
  - `revision` — `git rev-list --count HEAD` at deploy time: the number of
               commits reachable from the deployed commit. THIS is what makes
               "at or past revision N" answerable, and it is deliberately not
               a counter that increments once per deploy:

               A deploy counter goes up on every run regardless of what
               shipped, so a ROLLBACK (redeploying an older commit) would
               report a revision higher than the one that actually had the
               routes a sibling needs — a false "yes, at or past" fired
               exactly when the true answer is "no". A commit count is tied
               to the code's real position in history instead: redeploying
               the same commit reports the same revision (correctly "at
               least as new" — an equality, not a regression); rolling back
               to an older commit reports a LOWER revision, because that
               commit genuinely has fewer ancestors. The number tracks what
               is actually live, not how many times something was run.

## Why `app.openapi()` rather than walking `app.routes`

FastAPI's route tree is an internal representation that has changed shape
across versions (this repo pins 0.115+, and the installed 0.138 already
resolves routes lazily through `_IncludedRouter`/`effective_route_contexts`
rather than flattening them at include time) — a naive `app.routes` walk
silently under-counts on some versions, seen locally: 6 routes instead of the
real 70. `app.openapi()` is the same computation FastAPI itself uses to build
the (gated) `/openapi.json` body, so it reflects every declared route
regardless of internal representation, without this script depending on that
representation directly. Nothing computed here is served over HTTP.

## Usage

    uv run python scripts/route-table-digest.py --revision <int> --out <path>

Run from the repo root (needs `services/api/src` importable and the
workspace's Python dependencies installed — `uv sync --all-groups --locked`).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_app():
    # Local import, after the path insert: `api` is a workspace member with
    # no [build-system] (see services/api/pyproject.toml), so it is never
    # pip-installed — only reachable via this same sys.path hack
    # services/api/tests/conftest.py already uses for pytest. Deferring the
    # import into this function (rather than the module top level) keeps
    # ruff's E402 quiet without a noqa: it only flags module-level imports.
    sys.path.insert(0, str(_REPO_ROOT / "services/api/src"))
    from api.main import app

    return app


def _route_lines(app) -> list[str]:
    schema = app.openapi()
    lines: list[str] = []
    for path, methods in schema.get("paths", {}).items():
        for method in methods:
            if method.lower() in {
                "get",
                "post",
                "put",
                "patch",
                "delete",
                "options",
                "head",
                "trace",
            }:
                lines.append(f"{method.upper()} {path}")
    return sorted(set(lines))


def main() -> int:
    parser = argparse.ArgumentParser(description="Compute core's route-table digest (#1604).")
    parser.add_argument(
        "--revision",
        type=int,
        required=True,
        help="Monotonic revision to publish alongside the hash (git rev-list --count HEAD).",
    )
    parser.add_argument(
        "--out",
        required=True,
        help="Path to write the digest JSON to (also printed on stdout).",
    )
    args = parser.parse_args()

    if args.revision < 0:
        print(f"::error::route-table-digest: --revision must be >= 0, got {args.revision}")
        return 1

    app = _load_app()
    lines = _route_lines(app)
    if not lines:
        # A core deployment with zero declared routes is not a real state —
        # publishing a digest for it would tell every sibling "core is ready"
        # about an app that serves nothing. Fail the build instead of
        # shipping a digest nobody should trust.
        print(
            "::error::route-table-digest: app.openapi() reported zero routes; "
            "refusing to publish a digest for an empty route table."
        )
        return 1

    digest = hashlib.sha256("\n".join(lines).encode()).hexdigest()
    payload = {
        "revision": args.revision,
        "hash": digest,
        "routeCount": len(lines),
        "generatedAt": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload) + "\n")
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
