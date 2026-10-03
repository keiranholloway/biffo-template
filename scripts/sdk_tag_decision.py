#!/usr/bin/env python3
"""Decide whether HEAD should be tagged ``sdk-v<version>`` (state-based).

Compares packages/python-sdk/pyproject.toml's version with the highest existing
``sdk-v*`` tag:

  * higher -> TAG    (exit 0, ``action=tag``)
  * equal  -> NOOP   (exit 0, ``action=noop``)
  * lower  -> REFUSE (exit 1): a release cannot go backwards
  * would-be tag already exists on a different commit -> REFUSE (exit 1)

Used by .github/workflows/sdk-tag.yml. With ``--github-output`` the decision is
appended to $GITHUB_OUTPUT as ``action=`` and ``tag=``. Needs full tag history.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tomllib
from pathlib import Path

SDK_PYPROJECT = "packages/python-sdk/pyproject.toml"


def parse_version(text: str) -> tuple[int, ...]:
    m = re.fullmatch(r"v?(\d+(?:\.\d+)*)", text.strip())
    if not m:
        raise ValueError(f"unparseable version: {text!r}")
    return tuple(int(p) for p in m.group(1).split("."))


def _pad(v: tuple[int, ...]) -> tuple[int, ...]:
    return v + (0,) * (4 - len(v))


def highest_sdk_version(tags: list[str]) -> str | None:
    best: tuple[int, ...] | None = None
    for t in tags:
        if not t.startswith("sdk-v"):
            continue
        try:
            v = parse_version(t[len("sdk-v") :])
        except ValueError:
            continue
        if best is None or _pad(v) > _pad(best):
            best = v
    return None if best is None else ".".join(str(p) for p in best)


def decide(version: str, tags: list[str], tag_commit: str | None, head: str) -> tuple[str, str]:
    """Return (action, message); action is 'tag', 'noop' or 'refuse'.

    ``tag_commit`` is the commit ``sdk-v<version>`` currently points at, or None.
    """
    try:
        cur = parse_version(version)
    except ValueError as e:
        return "refuse", str(e)
    top = highest_sdk_version(tags)
    if top is not None:
        if _pad(cur) < _pad(parse_version(top)):
            return "refuse", f"version {version} is lower than the highest tag sdk-v{top}"
        if _pad(cur) == _pad(parse_version(top)):
            return "noop", f"sdk-v{top} already released; nothing to do"
    tag = f"sdk-v{version}"
    if tag_commit is not None:
        if tag_commit != head:
            return "refuse", f"{tag} already exists on {tag_commit}, not HEAD ({head})"
        return "noop", f"{tag} already exists on HEAD"
    return "tag", f"tag HEAD {tag}"


def _git(*args: str, cwd: Path) -> str:
    return subprocess.run(  # noqa: S603
        ["git", *args],  # noqa: S607
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def main(root: str = ".", argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    base = Path(root)
    version = tomllib.loads((base / SDK_PYPROJECT).read_text())["project"]["version"]
    tags = _git("tag", "--list", "sdk-v*", cwd=base).split()
    tag = f"sdk-v{version}"
    head = _git("rev-parse", "HEAD", cwd=base)
    tag_commit = _git("rev-list", "-n", "1", tag, cwd=base) if tag in tags else None
    action, message = decide(version, tags, tag_commit, head)
    print(f"{action}: {message}")
    if "--github-output" in argv and os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"action={action}\n")
            if action == "tag":
                f.write(f"tag={tag}\n")
    return 1 if action == "refuse" else 0


if __name__ == "__main__":
    sys.exit(main())
