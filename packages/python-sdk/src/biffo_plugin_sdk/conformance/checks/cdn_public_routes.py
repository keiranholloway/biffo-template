"""#1523 seam 5 — manifest-declared CDN-contract routes asserted against
``modules/cloud/aws/cdn/path-contract.json`` (biffo-template#2087).

**Implemented.** The blocker this module used to name — ``RouteDef`` had no
field distinguishing a manifest route that corresponds to a CDN-contract row
from an ordinary tenant-scoped CRUD route — is closed:
``RouteDef.cdn_contract_key`` (``biffo_plugin_sdk.plugin``, mirrored in
``services/api/src/api/models/plugin_route.py``'s ``RouteDefinition``) names,
by its ``key`` field, the row in ``path-contract.json`` a route corresponds
to. This check asserts that cross-reference actually resolves: for every
manifest route carrying ``cdn_contract_key``, a row with that ``key`` must
exist in ``modules/cloud/aws/cdn/path-contract.json``. A route naming a key
with no matching row fails closed, naming the plugin, the route and the
missing key.

## What "public" does and does not mean here

The field is auth-adjacent, not an auth flag (#2087's own framing, echoing
this module's own earlier gap note). A ``cdn_contract_key`` says "the CDN
edge treats this path specially per that row's ``origin``/
``origin_path_prefix``/``token_required`` fields" — nothing more. It does
**not** mean "skips Core API tenant auth": every manifest-declared route is
still synthesised CRUD behind ``require_tenant_context()`` (ADR-0001)
regardless of whether it also carries a CDN-contract key. This check only
validates that a declared cross-reference resolves; it asserts nothing about,
and must never be read as granting, what the route is authorized to do.

## Where ``path-contract.json`` comes from

``modules/cloud/aws/cdn/`` is template-owned Terraform (ADR-0006) — a plugin
repo (this check's usual caller, via ``biffo plugin verify``) does not carry
a copy, and most plugin manifests will never declare a route with
``cdn_contract_key`` at all, since a manifest-declared route is ordinary
synthesised CRUD, and today the one contract-governed plugin-adjacent path
(``/c/<token>``, the ``click`` row) is hard-wired in Terraform rather than
manifest-declared. So this check looks for the contract file at
``<repo_root>/modules/cloud/aws/cdn/path-contract.json`` and, when it is
absent, treats the set of known contract keys as empty rather than erroring
— a manifest with zero ``cdn_contract_key`` routes has nothing to check
either way, and the file's absence is exactly what "no matching row" means
for any manifest that does declare one. This is deliberately the same
fail-closed shape whether the file is missing entirely or merely lacks the
named row: a plugin author who copies a ``cdn_contract_key`` from another
platform's contract into a repo that has no contract at all gets the same
clear failure as one whose key is simply wrong.

This module exists — now with a ``run`` — so ``--list-checks``'s implemented
count includes this seam (biffo-template#1924's own denominator framing,
extended by #2087: was ``1 implemented, 4 not-implemented``, is now
``2 implemented, 3 not-implemented``).
"""

from __future__ import annotations

import json
from pathlib import Path

from biffo_plugin_sdk.plugin import RouteDef, load_manifest

from .. import ConformanceCheckError, ConformanceContext

CHECK_NAME = "cdn_public_routes"
IMPLEMENTED = True
NOTE = (
    "asserts every manifest route's cdn_contract_key resolves against "
    "modules/cloud/aws/cdn/path-contract.json"
)

_CONTRACT_RELATIVE_PATH = Path("modules/cloud/aws/cdn/path-contract.json")


def _contract_keys(repo_root: Path) -> set[str]:
    """The set of ``key`` values declared in this repo's
    ``path-contract.json``, or an empty set if the file is absent -- see this
    module's own docstring for why absence and "no matching row" are the same
    fail-closed outcome here."""
    contract_path = repo_root / _CONTRACT_RELATIVE_PATH
    if not contract_path.is_file():
        return set()

    try:
        data = json.loads(contract_path.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise ConformanceCheckError(f"{contract_path} is not valid JSON: {exc}") from exc

    rows = data.get("rows", [])
    return {row["key"] for row in rows if isinstance(row, dict) and "key" in row}


def run(ctx: ConformanceContext) -> None:
    manifest_path = ctx.repo_root / "biffo.plugin.json"
    if not manifest_path.is_file():
        raise ConformanceCheckError(f"no biffo.plugin.json at {manifest_path}")

    try:
        manifest = load_manifest(manifest_path)
    except (FileNotFoundError, ValueError) as exc:
        raise ConformanceCheckError(f"{manifest_path} failed to validate: {exc}") from exc

    contract_routes: list[RouteDef] = [r for r in manifest.api_routes if r.cdn_contract_key]
    print(
        f"cdn_public_routes: {len(contract_routes)} declared route(s) carry a cdn_contract_key",
        flush=True,
    )
    if not contract_routes:
        print(
            "cdn_public_routes: nothing to check -- 0 routes reference the CDN contract",
            flush=True,
        )
        return

    contract_keys = _contract_keys(ctx.repo_root)

    missing = [
        f"{manifest.name}: {route.method} {route.path} "
        f"(cdn_contract_key={route.cdn_contract_key!r})"
        for route in contract_routes
        if route.cdn_contract_key not in contract_keys
    ]
    if missing:
        known = sorted(contract_keys) or "none"
        raise ConformanceCheckError(
            f"{len(missing)}/{len(contract_routes)} route(s) declare a cdn_contract_key with no "
            f"matching row in {_CONTRACT_RELATIVE_PATH} (known keys: {known}): "
            + "; ".join(missing)
        )

    print(
        f"cdn_public_routes: {len(contract_routes)}/{len(contract_routes)} declared route(s) "
        f"resolved against {_CONTRACT_RELATIVE_PATH}",
        flush=True,
    )
