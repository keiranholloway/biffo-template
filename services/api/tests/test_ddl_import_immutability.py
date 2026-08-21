"""Applied DDL is immutable — including its comments — and only a deploy knows.

`_run_ddl_import` records a sha256 of every `db/imports/<name>/*.sql` file it
applies, into `ddl_import_history` **in the deployed database**. If a file's
bytes later change, the next deploy hard-fails:

    DDL file '012_rbac_legacy_cleanup.sql' in import 'tabsii' has changed since
    it was applied (checksum d6ff242e... -> 17e5611f...). This tool does not
    support modifying already-applied DDL — add a new file instead.

That guardrail is correct and it fires far too late. The checksums live in a
running database, so **nothing a developer can run sees this**: on 2026-08-02 a
repo-wide find-and-replace rewrote an ADR citation inside 21 already-applied
modules in tabsii-platform, and `verify.sh`, the full pytest suite, the
real-Postgres RLS lane and every CI check were green. The damage surfaced 2h25m
later, on the deploy of an unrelated PR, after **five consecutive failed
deploys** — four of them innocent changes by other people that had merely
inherited a poisoned integration branch.

The edit was a *comment*. Nothing in the tooling said that comments count, and
the natural mental model — "it is only a comment, the SQL is unchanged" — is
wrong here in a way that costs an afternoon.

## What this asserts

Any `db/imports/**/*.sql` file that already exists on the **base branch** must be
byte-identical to it. New files are unconstrained; that is the sanctioned way to
change applied schema, and the error message above says so.

The base branch is the best available local proxy for "already applied": a
module reaches `dev` and is deployed within minutes, so in practice everything
on `dev` is applied everywhere. It is a proxy and not the truth — see the
deliberate gap below.

## Why a git check and not a checksum manifest

A committed manifest of checksums would be a second source of truth that can
drift from `ddl_import_history`, and updating it would be exactly the action
this test needs to forbid. Git already knows what the base branch holds.

## Deliberate gaps, stated rather than discovered later

- **A module merged but never successfully applied** (its deploy failed) is
  frozen by this test even though editing it would be safe. Rare, and the
  escape is to revert-and-replace with a new number rather than weaken this.
- **A module applied to one environment and not another** is not modelled. The
  base branch is one boolean; reality is per-environment. When staging and prod
  exist this becomes materially wrong, and the honest fix then is to read
  `ddl_import_history` from each environment rather than to guess harder here.
- **Nothing here runs in a repo with no `db/imports/`**, which is the template
  itself — see `test_the_guard_is_not_vacuous_where_it_matters`.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

# services/api/tests/ -> services/api -> services -> <repo root>
REPO_ROOT = Path(__file__).resolve().parents[3]
IMPORTS_ROOT = REPO_ROOT / "db" / "imports"

#: Checked in order; the first that resolves is used. `origin/dev` is the
#: integration branch every Biffo repo merges into (AGENTS.md §2); the bare
#: `dev` fallback covers a clone with no remote configured.
BASE_REFS = ("origin/dev", "dev")


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    # nosec B603 / noqa S603 — every argument is a module-scope literal or a
    # path this repo already tracks; nothing here originates from a request or
    # from user input. `git` is resolved from PATH deliberately, so the test
    # uses whatever git the developer and CI actually run.
    return subprocess.run(  # noqa: S603
        ["git", *args],  # noqa: S607  # nosec B603,B607
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def _fetch_base() -> None:
    """Try to make a base ref exist. CI checks out shallow, so none does by default.

    `actions/checkout` defaults to depth 1 and the Python job sets no `fetch-depth`, so
    `origin/dev` is simply absent in CI -- and this guard then SKIPPED. Measured
    2026-08-21: noisy where it does not matter (locally, on false positives) and silent
    where it does (CI, the only place it gates anything).

    A shallow fetch is not enough: `A...B` needs a common ancestor, and two depth-1
    histories have none. So this deepens rather than adds a single commit. It is best
    effort -- no network, no token, no remote all leave the ref unresolved, and the caller
    decides what that means.
    """
    for branch in ("dev", "main"):
        _git(
            "fetch",
            "--no-tags",
            "--quiet",
            "--deepen=200",
            "origin",
            f"+refs/heads/{branch}:refs/remotes/origin/{branch}",
        )


def _resolve_base() -> str | None:
    for ref in BASE_REFS:
        if _git("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}").returncode == 0:
            return ref
    return None


def _sql_files_on(ref: str) -> set[str]:
    out = _git("ls-tree", "-r", "--name-only", ref, "db/imports/")
    if out.returncode != 0:
        return set()
    return {p for p in out.stdout.split("\n") if p.endswith(".sql")}


def _modified_against(ref: str) -> list[str]:
    """Repo-relative paths of applied DDL whose bytes differ from the base."""
    on_base = _sql_files_on(ref)
    if not on_base:
        return []
    # --name-only over the *intersection*: a file absent from the base is new
    # and legitimately unconstrained, so it must not be reported here.
    #
    # THREE DOTS, NOT TWO, AND THE DIFFERENCE IS THE WHOLE TEST.
    #
    # `git diff <ref> -- <paths>` compares the working tree against the TIP of the base, so
    # it reports changes in EITHER direction: a branch merely BEHIND dev on a DDL file is
    # accused of modifying it, having touched no DDL at all. Measured on tabsii-platform's
    # #1016 branch (2026-08-21): it named 152_finance_marketing_fund.sql and
    # 155_finance_fx_rates.sql, both of which arrived on dev AFTER that branch was cut, and
    # `git diff origin/dev...branch -- db/imports/` was empty.
    #
    # `<ref>...HEAD` diffs from the MERGE BASE, which asks the only question that matters:
    # what did THIS branch change. The builder's workaround for the false positive was to
    # verify by hand with the three-dot form and proceed past the local failure -- so the
    # guard was already training people to ignore it, which is how a real hit gets missed.
    out = _git("diff", "--name-only", f"{ref}...HEAD", "--", *sorted(on_base))
    if out.returncode != 0:
        pytest.skip(f"could not diff against {ref}: {out.stderr.strip()}")
    return [p for p in out.stdout.split("\n") if p.endswith(".sql")]


class TestAppliedDdlIsNeverModified:
    def test_no_sql_file_present_on_the_base_branch_has_changed(self) -> None:
        if not IMPORTS_ROOT.is_dir():
            pytest.skip("no db/imports/ in this repo")
        base = _resolve_base()
        if base is None:
            _fetch_base()
            base = _resolve_base()
        if base is None:
            _fetch_base()
            base = _resolve_base()
        # A GUARD THAT CANNOT RUN MUST NOT PASS.
        #
        # This skipped here, which reads as green. In CI that was the ONLY outcome, because
        # the checkout is shallow -- so the check that exists to stop a deploy hard-failing
        # on a DDL checksum mismatch has never actually run there. `db/imports/` existing is
        # the signal that this repo has applied DDL to protect; if it does and the base
        # cannot be established even after a fetch, that is a failure to report, not a pass.
        assert base is not None, (
            f"none of {BASE_REFS} resolves even after fetching, so what is already applied "
            "cannot be established and this guard cannot run. It is NOT passing.\n\n"
            "In CI this usually means the checkout is shallow: add `fetch-depth: 0` to the "
            "actions/checkout step for the job that runs this test."
        )

        modified = _modified_against(base)
        assert not modified, (
            "Already-applied DDL modified — the next deploy will hard-fail on a "
            "checksum mismatch and take the whole integration branch with it:\n  "
            + "\n  ".join(sorted(modified))
            + "\n\nApplied DDL is immutable INCLUDING ITS COMMENTS: the recorded "
            "checksum is over the whole file, so a reworded comment breaks it "
            "exactly as a changed statement would. Add a new numbered module "
            "instead. If you are deliberately reverting one of these files back "
            "to its applied bytes, this test passes once they match again."
        )

    def test_the_guard_is_not_vacuous_where_it_matters(self) -> None:
        """A guard that only ever skips is indistinguishable from no guard.

        This test does not assert that `db/imports/` exists — the template
        legitimately has none. It asserts that *where it does* exist, the check
        above actually had files to compare, rather than silently passing on an
        empty set because a ref name was wrong or `ls-tree` returned nothing.
        """
        if not IMPORTS_ROOT.is_dir():
            pytest.skip("no db/imports/ in this repo")
        base = _resolve_base()
        if base is None:
            pytest.skip(f"none of {BASE_REFS} resolves")

        on_disk = {p for p in IMPORTS_ROOT.rglob("*.sql")}
        assert on_disk, "db/imports/ exists but holds no .sql — the guard would be vacuous"
        assert _sql_files_on(base), (
            f"{base} reports no db/imports/**.sql, but {len(on_disk)} exist on disk. "
            "The comparison set is empty, so the immutability check above cannot "
            "fail — a passing run would mean nothing."
        )


class TestTheComparisonItself:
    """The helper must distinguish 'new file' from 'modified file'.

    Getting this backwards in either direction is costly: reporting new files
    blocks the sanctioned way to change schema, and missing modified ones is the
    defect this module exists for.
    """

    def test_a_file_absent_from_the_base_is_not_reported(self) -> None:
        base = _resolve_base()
        if base is None:
            pytest.skip("no base ref")
        on_base = _sql_files_on(base)
        # Nothing reported may be outside the base's own file set, by construction.
        assert set(_modified_against(base)) <= on_base
