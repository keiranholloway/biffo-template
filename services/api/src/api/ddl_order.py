"""The apply order of a DDL import's `.sql` files, derived at build (biffo-template#2458).

A module is authored as `db/imports/<name>/<slug>.sql`, with no sequence number. A
number picked when a change is written can collide: two open branches each take
"the next free number", and whichever merges second fails the duplicate-number
check and has to be renumbered and re-run (tabsii-platform 1577/1579, 2026-10-09:
two modules numbered 221 three seconds apart). Its position is instead derived
when the import is provisioned, from the merged default branch:

1. **Numbered files first, by name**, exactly as before. Every module that
   already exists keeps applying unchanged, in its current order, on every
   existing database. A numbered file is one whose name starts with a digit.
2. **Then unnumbered files, in the order they merged**: by the first-parent
   commit of the default branch (`origin/dev`) that added each one. That is
   merge order, and merge order is a valid order because each PR is tested
   against the base it merges onto. A file the default branch does not have
   yet (a PR's own module, on its merge ref or branch) follows, by the
   first-parent commit of `HEAD` that added it, which is where it will land.
   Files added by the same commit go by name; files git does not know yet
   (uncommitted) go last, by name.

The derived position is reported as a number, the next one after the highest
numbered file, in the order manifest below. It is never written into a
filename: the filename stays the module's identity, and the
`ddl_import_history` key, so a module's number cannot collide because nobody
picks it.

Two open PRs that each add a module therefore never conflict: their files have
different names, and each one's position is decided only when it merges.

## Where the order comes from at runtime

From git when this is a full (non-shallow) clone; a shallow clone reports every
file as added by its one commit, so it is refused rather than trusted. The
deployed Lambda has no git, so the deploy packaging writes the order into the
zip as `<import>/.apply-order` (`python3 ddl_order.py --manifest <dir>`, from a
`fetch-depth: 0` checkout) and the Lambda reads that. With neither, the order
cannot be derived and `apply_order` raises `DdlOrderUnavailableError`: applying in
some other order is how a module ends up running before the one it depends on.
An import with at most one unnumbered file (all numbered, or a plugin's single
`schema.sql`) needs neither: its order is the same either way.

This module is standard library only so that `scripts/pg-test-db.sh` and the
deploy packaging can run it as a plain script, outside the API's environment.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

MANIFEST_NAME = ".apply-order"
# The integration branch is `dev` in every Biffo repo (AGENTS.md section 2).
DEFAULT_BRANCH_REF = "origin/dev"

_NUMBERED = re.compile(r"^\d")
_LEADING_NUMBER = re.compile(r"^(\d+)")


class DdlOrderUnavailableError(RuntimeError):
    """The apply order of an import with unnumbered modules cannot be derived."""


def is_numbered(filename: str) -> bool:
    return bool(_NUMBERED.match(filename))


def apply_order(import_dir: Path) -> list[Path]:
    """The `.sql` files directly under `import_dir`, in apply order (module docstring)."""
    files = sorted(import_dir.glob("*.sql"))
    numbered = [f for f in files if is_numbered(f.name)]
    unnumbered = [f for f in files if not is_numbered(f.name)]
    if len(unnumbered) <= 1:
        return numbered + unnumbered

    added = _git_added_order(import_dir)
    if added is not None:
        never = len(added) + 1
        unnumbered.sort(key=lambda f: (added.get(f.name, never), f.name))
        return numbered + unnumbered

    manifest = import_dir / MANIFEST_NAME
    if manifest.is_file():
        return _read_manifest(manifest, files)

    raise DdlOrderUnavailableError(
        f"Cannot derive the apply order of {import_dir}: it has unnumbered modules "
        f"({', '.join(f.name for f in unnumbered)}), and neither a full git clone nor "
        f"an {MANIFEST_NAME} manifest is available. A shallow clone cannot order them; "
        "fetch full history (fetch-depth: 0)."
    )


def derived_numbers(order: list[Path]) -> list[tuple[int, Path]]:
    """Each file in `order` with its position as a number: a numbered file keeps its
    own; an unnumbered one takes the next number after the highest seen so far."""
    numbered: list[tuple[int, Path]] = []
    highest = -1
    for path in order:
        match = _LEADING_NUMBER.match(path.name)
        if match:
            number = int(match.group(1))
        else:
            number = highest + 1
        highest = max(highest, number)
        numbered.append((number, path))
    return numbered


def format_manifest(import_dir: Path) -> str:
    """The `.apply-order` manifest for `import_dir`: one `<number>\\t<filename>` line
    per module, in apply order."""
    numbered = derived_numbers(apply_order(import_dir))
    return "".join(f"{number:03d}\t{path.name}\n" for number, path in numbered)


def new_numbered_modules(import_dir: Path, base_ref: str = DEFAULT_BRANCH_REF) -> list[str] | None:
    """Numbered files this change adds to an import that already exists at its merge
    base with `base_ref`. None when git cannot tell (no repo, shallow, no `base_ref`).

    A new import (absent at the merge base) may bring its numbered chain with it:
    `biffo data import` vendors an existing chain in one commit.
    """
    if _git(import_dir, "rev-parse", "--show-toplevel") is None or _is_shallow(import_dir):
        return None
    base = _git(import_dir, "merge-base", "HEAD", base_ref)
    if base is None:
        return None
    base = base.strip()
    existing_at_base = _git(import_dir, "ls-tree", "--name-only", base, "--", ".")
    if existing_at_base is None:
        return None
    base_names = {
        Path(line).name for line in existing_at_base.splitlines() if line.endswith(".sql")
    }
    if not base_names:
        return []
    return sorted(
        f.name for f in import_dir.glob("*.sql") if is_numbered(f.name) and f.name not in base_names
    )


def _read_manifest(manifest: Path, files: list[Path]) -> list[Path]:
    by_name = {f.name: f for f in files}
    names: list[str] = []
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        names.append(line.split("\t")[-1].strip())
    if sorted(names) != sorted(by_name):
        missing = sorted(set(by_name) - set(names))
        extra = sorted(set(names) - set(by_name))
        raise DdlOrderUnavailableError(
            f"{manifest} does not match the .sql files beside it "
            f"(not in the manifest: {missing or 'none'}; "
            f"in the manifest but absent: {extra or 'none'}). "
            "It is written by the deploy packaging from the same files; rebuild the package."
        )
    return [by_name[name] for name in names]


def _git(import_dir: Path, *args: str) -> str | None:
    try:
        result = subprocess.run(  # noqa: S603 -- fixed git argv, no shell
            ["git", "-C", str(import_dir), *args],  # noqa: S607
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    return result.stdout if result.returncode == 0 else None


def _is_shallow(import_dir: Path) -> bool:
    return _git(import_dir, "rev-parse", "--is-shallow-repository") != "false\n"


def _git_added_order(import_dir: Path) -> dict[str, int] | None:
    """filename -> its merge position, or None when this is not a full git clone.

    The position is the index of the first-parent commit that added the file on
    the default branch (`DEFAULT_BRANCH_REF`) when it is there, else on `HEAD`,
    after every default-branch position. The default branch comes first because
    a promotion branch (staging, main) receives dev's modules in one promotion
    commit, and its own first-parent history would order them by name.
    """
    if _git(import_dir, "rev-parse", "--show-toplevel") is None or _is_shallow(import_dir):
        return None
    added: dict[str, int] = {}
    offset = 0
    for ref in (DEFAULT_BRANCH_REF, "HEAD"):
        if _git(import_dir, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}") is None:
            continue
        log = _git(
            import_dir,
            "log",
            ref,
            "--first-parent",
            "--diff-merges=first-parent",
            "--no-renames",
            "--diff-filter=A",
            "--reverse",
            "--relative",
            "--format=%x00",
            "--name-only",
            "--",
            ".",
        )
        if log is None:
            return None
        commits = log.split("\x00")
        on_ref: dict[str, int] = {}
        for index, commit in enumerate(commits):
            for name in commit.splitlines():
                if name and "/" not in name and name.endswith(".sql"):
                    on_ref[name] = offset + index
        for name, position in on_ref.items():
            added.setdefault(name, position)
        offset += len(commits)
    return added


def main(argv: list[str]) -> int:
    """`ddl_order.py DIR...` prints each directory's files in apply order, one path
    per line (directories in the order given); `ddl_order.py --manifest DIR` prints
    DIR's `.apply-order` manifest."""
    try:
        if argv[:1] == ["--manifest"] and len(argv) == 2:
            sys.stdout.write(format_manifest(Path(argv[1])))
            return 0
        if not argv or argv[0].startswith("-"):
            print(main.__doc__, file=sys.stderr)
            return 2
        for directory in argv:
            for path in apply_order(Path(directory)):
                print(path)
        return 0
    except DdlOrderUnavailableError as exc:
        print(f"ddl_order: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
