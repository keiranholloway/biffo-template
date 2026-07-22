"""The core Alembic chain is a single, fully-connected line.

Nothing else asserts this. The chain is only ever exercised by ``db-init``
running ``command.upgrade(cfg, "head")`` inside the Lambda, so a broken graph is
discovered as a **failed deploy** rather than a failed test — and, for a live
instance, discovered in production.

The CLI validates the chain too (``cli/src/lib/core-migrations.ts``), but only
when ``biffo core upgrade`` runs, and only over the trees it is carrying between.
A template migration committed with a typo'd ``down_revision`` is wrong the
moment it lands here, whether or not anybody runs an upgrade. Hence a cheap test
next to the migrations themselves (issue #366).

Deliberately parses the files rather than booting Alembic: no database, no
config, no import of the app. The failure this catches is textual.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import NamedTuple

VERSIONS_DIR = Path(__file__).resolve().parents[1] / "migrations" / "versions"


class Migration(NamedTuple):
    file: str
    revision: str
    down_revision: str | None


def _literal(node: ast.AST) -> str | None:
    """The value of a module-level string/None literal, or raise for anything else.

    A computed revision id is not something the carry (or this test) can reason
    about, and Alembic itself resolves it only at import time.
    """
    if isinstance(node, ast.Constant) and (isinstance(node.value, str) or node.value is None):
        return node.value
    raise AssertionError(f"revision literals must be a plain string or None, got {ast.dump(node)}")


def _parse(path: Path) -> Migration:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: dict[str, str | None] = {}
    for stmt in tree.body:
        # `revision: str = "0001"` (annotated) and `revision = "0001"` both occur
        # depending on the Alembic template version that generated the file.
        if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            if stmt.target.id in ("revision", "down_revision") and stmt.value is not None:
                found[stmt.target.id] = _literal(stmt.value)
        elif isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                if isinstance(target, ast.Name) and target.id in ("revision", "down_revision"):
                    found[target.id] = _literal(stmt.value)

    assert "revision" in found, f"{path.name}: no module-level 'revision' assignment"
    assert "down_revision" in found, f"{path.name}: no module-level 'down_revision' assignment"
    revision = found["revision"]
    assert revision is not None, f"{path.name}: 'revision' must not be None"
    return Migration(path.name, revision, found["down_revision"])


def _migrations() -> list[Migration]:
    return [_parse(p) for p in sorted(VERSIONS_DIR.glob("*.py")) if p.name != "__init__.py"]


def test_there_are_migrations_to_check() -> None:
    # Without this the whole module passes vacuously if the glob ever breaks —
    # a test that cannot fail is worse than no test, because it is trusted.
    assert _migrations(), f"no migrations found under {VERSIONS_DIR}"


def test_revision_ids_are_unique() -> None:
    migrations = _migrations()
    seen: dict[str, str] = {}
    for m in migrations:
        assert m.revision not in seen, (
            f"duplicate revision id {m.revision!r} in {m.file} and {seen[m.revision]}"
        )
        seen[m.revision] = m.file


def test_every_down_revision_resolves() -> None:
    migrations = _migrations()
    known = {m.revision for m in migrations}
    for m in migrations:
        if m.down_revision is not None:
            assert m.down_revision in known, (
                f"{m.file} chains onto down_revision {m.down_revision!r}, "
                "which no migration defines"
            )


def test_exactly_one_base_and_one_head() -> None:
    migrations = _migrations()
    bases = [m.file for m in migrations if m.down_revision is None]
    parents = {m.down_revision for m in migrations if m.down_revision is not None}
    heads = [m.file for m in migrations if m.revision not in parents]

    assert len(bases) == 1, f"expected exactly one base migration, found {bases}"
    # Two heads is what a badly re-chained carry produces, and Alembic refuses to
    # upgrade a branched chain without an explicit merge.
    assert len(heads) == 1, f"expected exactly one head, found {heads}"


def test_every_revision_is_reachable_from_the_base() -> None:
    migrations = _migrations()
    by_parent: dict[str | None, list[Migration]] = {}
    for m in migrations:
        by_parent.setdefault(m.down_revision, []).append(m)

    reachable: set[str] = set()
    frontier = list(by_parent.get(None, []))
    while frontier:
        current = frontier.pop()
        if current.revision in reachable:  # pragma: no cover - a cycle
            raise AssertionError(f"cycle detected at {current.file}")
        reachable.add(current.revision)
        frontier.extend(by_parent.get(current.revision, []))

    orphans = sorted(m.file for m in migrations if m.revision not in reachable)
    assert not orphans, f"migrations unreachable from the base: {orphans}"
