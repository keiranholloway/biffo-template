"""`biffo_plugin_sdk.conformance`'s discovery and CLI driver (biffo-template#1924).

Two things this milestone's own done-when depends on:

- ``discover_checks()`` finds every module under ``conformance/checks/`` by
  globbing, not a hand-maintained registry, and a not-yet-implemented seam is
  still named rather than silently missing from the denominator
  (``--list-checks`` must print ``2 implemented, 3 not-implemented`` as of
  biffo-template#2087, up from #1924's original ``1 implemented,
  4 not-implemented``).
- ``__main__``'s ``run_checks``/``list_checks`` fail closed on an empty
  discovery (a broken install, never a vacuous pass — #1363's shape), never
  confuse a check's own bug with the thing it was checking, and aggregate
  every failure rather than stopping at the first.
"""

from __future__ import annotations

from pathlib import Path

from biffo_plugin_sdk.conformance import (
    CheckSpec,
    ConformanceCheckError,
    ConformanceContext,
    discover_checks,
)
from biffo_plugin_sdk.conformance.__main__ import (
    _EMPTY_DISCOVERY_MESSAGE,
    list_checks,
    run_checks,
)


class TestDiscoverChecks:
    def test_discovers_all_five_1523_seams(self):
        names = {check.name for check in discover_checks()}
        assert names == {
            "host_mount",
            "cdn_public_routes",
            "config_resolution",
            "migrations",
            "real_core",
        }

    def test_exactly_three_implemented_matches_2086_and_2087s_own_done_when(self):
        """#1924 shipped `1 implemented, 4 not-implemented`; #2087
        (cdn_public_routes) and #2086 (config_resolution, gated on #1517 which
        has since landed) each moved one more check, so `--list-checks` now
        prints `3 implemented, 2 not-implemented`."""
        checks = discover_checks()
        implemented = [c.name for c in checks if c.implemented]
        assert implemented == ["cdn_public_routes", "config_resolution", "host_mount"]
        assert len(checks) == 5

    def test_a_not_implemented_check_has_no_run_even_if_the_module_defined_one(self):
        """`discover_checks` gates `run` on the module's own `IMPLEMENTED` flag,
        not merely on whether a `run` attribute happens to exist."""
        checks = {c.name: c for c in discover_checks()}
        for name in ("migrations", "real_core"):
            assert checks[name].run is None
            assert checks[name].implemented is False

    def test_implemented_checks_carry_a_callable_run(self):
        checks = {c.name: c for c in discover_checks()}
        assert callable(checks["host_mount"].run)
        assert callable(checks["config_resolution"].run)
        assert callable(checks["cdn_public_routes"].run)

    def test_sorted_by_name(self):
        names = [c.name for c in discover_checks()]
        assert names == sorted(names)


class _FakeCheck:
    """A minimal stand-in installed via monkeypatch, so `__main__`'s own
    aggregation/fail-closed logic is tested without depending on the real
    `host_mount` check's Postgres-free but still real-import behaviour."""

    def __init__(self, name: str, *, implemented: bool = True, run=None):
        self.spec = CheckSpec(name=name, implemented=implemented, note="", run=run)


def _passing(_ctx: ConformanceContext) -> None:
    return None


def _failing(_ctx: ConformanceContext) -> None:
    raise ConformanceCheckError("declared assertion failed")


def _crashing(_ctx: ConformanceContext) -> None:
    raise RuntimeError("a check's own bug, not the thing it was checking")


class TestRunChecks:
    def test_empty_discovery_fails_closed_not_a_vacuous_pass(self, monkeypatch, capsys):
        monkeypatch.setattr("biffo_plugin_sdk.conformance.__main__.discover_checks", lambda: [])
        assert run_checks(Path("/repo"), None) == 1
        assert _EMPTY_DISCOVERY_MESSAGE in capsys.readouterr().err

    def test_zero_implemented_checks_fails_even_with_a_nonempty_discovery(
        self, monkeypatch, capsys
    ):
        specs = [_FakeCheck("a", implemented=False).spec, _FakeCheck("b", implemented=False).spec]
        monkeypatch.setattr("biffo_plugin_sdk.conformance.__main__.discover_checks", lambda: specs)
        assert run_checks(Path("/repo"), None) == 1
        err = capsys.readouterr().err
        assert "0/2" in err

    def test_all_implemented_checks_passing_is_green(self, monkeypatch, capsys):
        specs = [_FakeCheck("a", run=_passing).spec, _FakeCheck("b", run=_passing).spec]
        monkeypatch.setattr("biffo_plugin_sdk.conformance.__main__.discover_checks", lambda: specs)
        assert run_checks(Path("/repo"), None) == 0
        assert "2/2 check(s) passed" in capsys.readouterr().out

    def test_a_declared_assertion_failure_fails_the_job_and_names_the_check(
        self, monkeypatch, capsys
    ):
        specs = [_FakeCheck("a", run=_passing).spec, _FakeCheck("b", run=_failing).spec]
        monkeypatch.setattr("biffo_plugin_sdk.conformance.__main__.discover_checks", lambda: specs)
        assert run_checks(Path("/repo"), None) == 1
        err = capsys.readouterr().err
        assert "FAIL b: declared assertion failed" in err
        assert "1/2 check(s) failed: b" in err

    def test_an_unexpected_crash_is_reported_separately_from_a_declared_failure(
        self, monkeypatch, capsys
    ):
        """A check's own bug must never be confused with the thing it was
        checking — `__main__.py`'s own stated distinction."""
        specs = [_FakeCheck("a", run=_crashing).spec]
        monkeypatch.setattr("biffo_plugin_sdk.conformance.__main__.discover_checks", lambda: specs)
        assert run_checks(Path("/repo"), None) == 1
        err = capsys.readouterr().err
        assert "FAIL a: unexpected error: a check's own bug" in err

    def test_every_check_runs_even_after_an_earlier_one_fails(self, monkeypatch, capsys):
        """Failures are aggregated, not short-circuited on the first one."""
        specs = [
            _FakeCheck("a", run=_failing).spec,
            _FakeCheck("b", run=_failing).spec,
            _FakeCheck("c", run=_passing).spec,
        ]
        monkeypatch.setattr("biffo_plugin_sdk.conformance.__main__.discover_checks", lambda: specs)
        assert run_checks(Path("/repo"), None) == 1
        err = capsys.readouterr().err
        assert "2/3 check(s) failed: a, b" in err

    def test_context_carries_repo_root_and_dsn_through_to_the_check(self, monkeypatch):
        seen: list[ConformanceContext] = []

        def _record(ctx: ConformanceContext) -> None:
            seen.append(ctx)

        specs = [_FakeCheck("a", run=_record).spec]
        monkeypatch.setattr("biffo_plugin_sdk.conformance.__main__.discover_checks", lambda: specs)
        run_checks(Path("/repo/root"), "postgres://x/y")
        assert seen == [ConformanceContext(repo_root=Path("/repo/root"), dsn="postgres://x/y")]


class TestListChecks:
    def test_empty_discovery_fails_closed(self, monkeypatch, capsys):
        monkeypatch.setattr("biffo_plugin_sdk.conformance.__main__.discover_checks", lambda: [])
        assert list_checks() == 1
        assert _EMPTY_DISCOVERY_MESSAGE in capsys.readouterr().err

    def test_prints_every_seam_with_its_state_and_the_denominator_line(self, capsys):
        """Exercises the real (non-monkeypatched) discovery, so this doubles as
        an end-to-end check on the denominator's current wording (#1924 shipped
        `1 implemented, 4 not-implemented`; #2087 and #2086 each moved one more
        to `3 implemented, 2 not-implemented`)."""
        assert list_checks() == 0
        out = capsys.readouterr().out
        assert "host_mount" in out
        assert "config_resolution" in out
        assert "cdn_public_routes" in out
        assert "implemented" in out
        assert "not-implemented" in out
        assert "3 implemented, 2 not-implemented" in out
