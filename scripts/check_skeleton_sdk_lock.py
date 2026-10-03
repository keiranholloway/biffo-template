#!/usr/bin/env python3
"""Catch a stale plugin-skeleton uv.lock against the published biffo-plugin-sdk.

Compares three versions: the SDK source version (packages/python-sdk/pyproject.toml),
the newest published ``sdk-v*`` git tag, and the version the skeleton's uv.lock
pins for ``biffo-plugin-sdk``.

  * lock <  tag     -> FAIL (exit 1), naming the fix.
  * source > tag    -> WARN (exit 0): source is unpublished; skeleton stays on lock.
  * otherwise       -> pass.

Needs full tag history (``fetch-depth: 0``). No tags at all fails closed.
"""

from __future__ import annotations

import re
import subprocess
import sys
import tomllib
from pathlib import Path

SDK_PYPROJECT = "packages/python-sdk/pyproject.toml"
SKELETON_DIR = "_skeletons/plugin-template"
SKELETON_LOCK = f"{SKELETON_DIR}/uv.lock"
FIX = f"run `uv lock --upgrade-package biffo-plugin-sdk` in {SKELETON_DIR} and commit uv.lock"


def parse_version(text: str) -> tuple[int, ...]:
    m = re.fullmatch(r"v?(\d+(?:\.\d+)*)", text.strip())
    if not m:
        raise ValueError(f"unparseable version: {text!r}")
    return tuple(int(p) for p in m.group(1).split("."))


def newest_sdk_tag(tags: list[str]) -> str | None:
    versions = []
    for t in tags:
        if t.startswith("sdk-v"):
            try:
                versions.append(parse_version(t[len("sdk-v") :]))
            except ValueError:
                continue
    if not versions:
        return None
    return ".".join(str(p) for p in max(versions))


def lock_sdk_version(lock_text: str) -> str:
    data = tomllib.loads(lock_text)
    for pkg in data.get("package", []):
        if pkg.get("name") == "biffo-plugin-sdk":
            return pkg["version"]
    raise ValueError("biffo-plugin-sdk not found in lock")


def source_version(pyproject_text: str) -> str:
    return tomllib.loads(pyproject_text)["project"]["version"]


def compare(source: str, tag: str, lock: str) -> tuple[list[str], list[str]]:
    """Return (errors, warnings)."""
    errors: list[str] = []
    warnings: list[str] = []
    if parse_version(lock) < parse_version(tag):
        errors.append(
            f"skeleton lock pins biffo-plugin-sdk {lock} but sdk-v{tag} is published. Fix: {FIX}."
        )
    if parse_version(source) > parse_version(tag):
        warnings.append(
            f"source {source} is unpublished (newest tag sdk-v{tag}); "
            f"the skeleton stays on {lock}. Cut the release, then bump the skeleton lock."
        )
    return errors, warnings


def main(root: str = ".") -> int:
    base = Path(root)
    out = subprocess.run(
        ["git", "tag", "--list", "sdk-v*"],  # noqa: S607
        cwd=base,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    tag = newest_sdk_tag(out)
    if tag is None:
        print("ERROR: no sdk-v* tags found; checkout needs fetch-depth: 0.", file=sys.stderr)
        return 1
    src = source_version((base / SDK_PYPROJECT).read_text())
    lock = lock_sdk_version((base / SKELETON_LOCK).read_text())
    errors, warnings = compare(src, tag, lock)
    for w in warnings:
        print(f"::warning::{w}")
    for e in errors:
        print(f"::error::{e}")
    if not errors:
        print(f"OK: skeleton lock {lock}, newest tag sdk-v{tag}, source {src}.")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "."))
