#!/usr/bin/env python3
"""Validate the Python dependencies an instance's product domains declare (#891).

ADR-0022 gave an instance's product-domain code a user-owned home at
``services/api/src/api/domains/<name>/``. It did not give that code a way to
declare its own Python dependencies: ``services/api/pyproject.toml`` is
template-owned, so a domain needing anything the template does not already ship
had to fork the template-owned manifest — which is what tabsii-platform does for
``geoalchemy2``/``shapely``. Taking those upstream is the wrong answer (#890):
every instance would pay the import cost for one instance's geometry columns
(#724 measured cold start as a real problem).

## The mechanism: a second, constrained layer — never a merged resolution

A domain declares its dependencies in a **fully pinned** requirements file at
``services/api/src/api/domains/<name>/requirements.txt``. That file lives inside
the user-owned carve-out, so the instance owns it outright: no template-owned
manifest is forked, and nothing has to be added to ``core-manifest.json`` for it
to work in an instance that already has ADR-0022.

``scripts/sync-domain-deps.sh`` installs those files **after** the core's own
``uv export --frozen`` set, with that exported set passed as a ``--constraint``.
Core resolves first and wins; domain dependencies are layered on top of a
resolution they cannot participate in. That is the whole supply-chain argument:

* A domain **cannot silently shadow or downgrade a core dependency.** Declaring
  a name the workspace lock already carries is rejected outright by this module
  (a legible, early failure in CI), and would in any case be impossible to
  install at a different version because the core export constrains it — uv
  fails the deploy rather than overwriting core's copy in the package directory.
* A domain **cannot silently pull a core dependency's transitives to a different
  version** either. Those are covered by the same constraint file, so a domain
  whose transitive closure disagrees with core's lock is a hard, loud
  resolution error, not a package directory that quietly changed underneath the
  core API.
* A domain **cannot redirect the index** it installs from. Option lines
  (``--index-url``, ``--extra-index-url``, ``--find-links``, ``-e``, nested
  ``-r``/``-c`` includes) are rejected: a requirements file is data here, not a
  program, and index substitution is the cheapest supply-chain attack there is.
* A domain **cannot float.** Every requirement must be pinned with ``==``, so the
  file is its own lockfile. The workspace ``uv.lock`` stays exactly what the
  template shipped; ``--frozen`` (#410) keeps its meaning; and what a domain
  installs is as reviewable, and as reproducible, as what core installs. Generate
  it with ``uv pip compile``.

## Where this runs

Both places, from this one implementation, so the two can never disagree:

* ``ci.yml`` installs domain dependencies into the venv right after ``uv sync``,
  which is what makes a domain's own tests, ``pyright`` and ``pip-audit``
  actually see them. (That last one matters: an unaudited dependency set is the
  fail-open shape ``scripts/py-dependency-audit.sh`` already exists to fight.)
* ``deploy-app.yml`` installs them into ``package/`` before the zip, which is
  what makes them reach the deployed Lambda — a resolution that stops at the
  developer's machine is not a mechanism.

Usage::

    python scripts/domain_requirements.py --check   # validate; exit 1 on any error
    python scripts/domain_requirements.py --list    # print each file, one per line
"""

from __future__ import annotations

import argparse
import re
import sys
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DOMAINS_DIR = REPO_ROOT / "services" / "api" / "src" / "api" / "domains"
REQUIREMENTS_NAME = "requirements.txt"
WORKSPACE_LOCK = REPO_ROOT / "uv.lock"

# `name[extra,extra]==version`, the ONLY accepted requirement shape. No ranges
# (the file is a lockfile), no URLs/VCS/local paths (unreviewable provenance),
# no bare names (would float).
_PINNED_RE = re.compile(
    r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)"
    r"(?:\[[A-Za-z0-9,._-]+\])?"
    r"==(?P<version>[A-Za-z0-9][A-Za-z0-9._+!-]*)$"
)


def normalize(name: str) -> str:
    """PEP 503 normalized distribution name, so `Geo_Alchemy.2` and
    `geo-alchemy-2` cannot be used to sneak a second copy of the same
    distribution past the shadowing check."""
    return re.sub(r"[-_.]+", "-", name).lower()


def locked_distributions(lock_path: Path | None = None) -> set[str]:
    """Every distribution name in the workspace lock, normalized.

    This is deliberately the WHOLE lock, not just `biffo-api`'s runtime subtree:
    anything already resolved for this workspace is core's to pin, and a domain
    restating it — at any version, in any group — is the shadowing case. Being
    over-broad here costs a domain nothing (the package is already installed and
    importable); being under-broad would let a dev-group name through and back
    into the package directory at a version nobody reviewed.
    """
    path = lock_path if lock_path is not None else WORKSPACE_LOCK
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    packages = data.get("package", [])
    return {normalize(str(p["name"])) for p in packages if "name" in p}


def requirement_files(domains_dir: Path | None = None) -> list[Path]:
    """Every domain requirements file, sorted. Empty for the base template,
    which ships no product domain."""
    root = domains_dir if domains_dir is not None else DOMAINS_DIR
    if not root.is_dir():
        return []
    return sorted(
        child / REQUIREMENTS_NAME
        for child in root.iterdir()
        if child.is_dir()
        and not child.name.startswith("_")
        and (child / REQUIREMENTS_NAME).is_file()
    )


def _strip_comment(line: str) -> str:
    return line.split("#", 1)[0].strip()


def _parse_line(raw: str) -> tuple[str, str] | str:
    """`(name, version)` for a valid pinned requirement, or an error string."""
    text = raw
    # Environment markers are legitimate and change nothing about provenance.
    if ";" in text:
        text = text.split(";", 1)[0].strip()
    if text.startswith("-"):
        return (
            f"option line {raw!r} is not allowed. A domain requirements file is data, "
            "not a program: index redirection (--index-url/--extra-index-url/"
            "--find-links), editable installs and nested -r/-c includes are all "
            "refused, because they move where the bytes come from without moving "
            "anything reviewable."
        )
    match = _PINNED_RE.match(text)
    if match is None:
        return (
            f"{raw!r} is not an exactly-pinned requirement. Write `name==version` "
            "(extras and environment markers are fine). Ranges, URLs, VCS refs and "
            "local paths are refused: this file IS the domain's lockfile, so it has "
            "to say precisely what ships. Generate it with `uv pip compile`."
        )
    return match.group("name"), match.group("version")


def check(
    domains_dir: Path | None = None,
    lock_path: Path | None = None,
) -> list[str]:
    """Every problem with the declared domain dependencies. Empty means valid."""
    errors: list[str] = []
    files = requirement_files(domains_dir)
    if not files:
        return errors

    locked = locked_distributions(lock_path)
    # normalized name -> (version, domain) of the first domain to claim it
    claimed: dict[str, tuple[str, str]] = {}

    for path in files:
        domain = path.parent.name
        for lineno, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            line = _strip_comment(raw_line)
            if not line:
                continue
            where = f"{domain}/{REQUIREMENTS_NAME}:{lineno}"
            parsed = _parse_line(line)
            if isinstance(parsed, str):
                errors.append(f"{where}: {parsed}")
                continue
            name, version = parsed
            key = normalize(name)

            if key in locked:
                errors.append(
                    f"{where}: {name!r} is already resolved in uv.lock, so it is a CORE "
                    "dependency and not a domain's to pin. Import it — it is already "
                    "installed. If the domain needs a different version, that is a "
                    "change to the core manifest, made deliberately and upstream, not "
                    "a package quietly replaced underneath the core API at deploy time."
                )
                continue

            previous = claimed.get(key)
            if previous is not None and previous[0] != version:
                errors.append(
                    f"{where}: {name}=={version} conflicts with {name}=={previous[0]} "
                    f"declared by domain {previous[1]!r}. Two domains sharing a "
                    "dependency must agree on its version — only one copy reaches the "
                    "Lambda, and letting install order decide which is exactly the "
                    "silent substitution this check exists to prevent."
                )
                continue
            if previous is None:
                claimed[key] = (version, domain)

    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true", help="validate; exit 1 on any error")
    group.add_argument("--list", action="store_true", help="print each requirements file")
    args = parser.parse_args(argv)

    if args.list:
        for path in requirement_files():
            print(path)
        return 0

    errors = check()
    if errors:
        print(
            "Product-domain dependency declarations are invalid (ADR-0022, #891):",
            file=sys.stderr,
        )
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
