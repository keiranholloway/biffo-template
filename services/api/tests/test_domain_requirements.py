"""A product domain may declare its own Python dependencies — but not core's (#891).

ADR-0022 gives an instance's product-domain code a user-owned home inside the
template-owned core API. `scripts/domain_requirements.py` is what lets such a
domain declare extra Python packages without forking the template-owned
`services/api/pyproject.toml`, and — much more importantly — what stops it using
that freedom to shadow, downgrade or re-source a package the core API depends on.

This test file lives under `services/api/tests/` deliberately. That path is
template-owned, so it is carried into every instance by `biffo core upgrade` and
runs against *that instance's real domains* on every one of its CI runs. The
equivalent guard in `cli/` would not: `cli/` is `released`, frozen in an instance
at `biffo init` time, so a check placed there would only ever protect the one
repo that has no product domains at all.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
MODULE_PATH = REPO_ROOT / "scripts" / "domain_requirements.py"


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("biffo_domain_requirements", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


dr = _load()


@pytest.fixture
def lock(tmp_path: Path) -> Path:
    """A minimal stand-in for the workspace `uv.lock`."""
    path = tmp_path / "uv.lock"
    path.write_text(
        "\n".join(
            [
                'requires-python = ">=3.13"',
                "",
                "[[package]]",
                'name = "sqlalchemy"',
                'version = "2.0.36"',
                "",
                "[[package]]",
                "name = 'aws-lambda-powertools'",
                "version = '3.4.0'",
                "",
                "[[package]]",
                'name = "pytest"',
                'version = "8.3.4"',
            ]
        ),
        encoding="utf-8",
    )
    return path


def _domains(tmp_path: Path, **files: str) -> Path:
    root = tmp_path / "domains"
    root.mkdir(exist_ok=True)
    for name, body in files.items():
        directory = root / name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "requirements.txt").write_text(body, encoding="utf-8")
    return root


class TestTheRealTree:
    """The instance's actual declarations, whatever they are, must be valid."""

    def test_the_repository_is_valid(self) -> None:
        assert dr.check() == []

    def test_the_module_is_reachable_at_the_path_the_scripts_use(self) -> None:
        # sync-domain-deps.sh and both workflows invoke it by this path; a move
        # that forgot them would leave a green suite and a broken deploy.
        assert MODULE_PATH.is_file()

    def test_the_base_template_declares_no_domain_dependencies(self) -> None:
        # Not a tautology: it pins that the mechanism is inert until an instance
        # opts in, which is what makes it safe to distribute to every instance.
        assert dr.requirement_files() == []


class TestDiscovery:
    def test_no_domains_directory_is_not_an_error(self, tmp_path: Path, lock: Path) -> None:
        assert dr.requirement_files(tmp_path / "absent") == []
        assert dr.check(tmp_path / "absent", lock) == []

    def test_a_domain_without_declarations_is_skipped(self, tmp_path: Path, lock: Path) -> None:
        root = _domains(tmp_path, billing="shapely==2.0.6\n")
        (root / "catalog").mkdir()
        assert [p.parent.name for p in dr.requirement_files(root)] == ["billing"]
        assert dr.check(root, lock) == []

    def test_private_directories_are_skipped(self, tmp_path: Path, lock: Path) -> None:
        # `_`-prefixed matches the domain router's own discovery rule, so a
        # scratch directory the router ignores does not gain a deploy-time voice.
        root = _domains(tmp_path, _scratch="sqlalchemy==1.4.0\n")
        assert dr.requirement_files(root) == []
        assert dr.check(root, lock) == []


class TestAcceptedDeclarations:
    def test_pins_extras_markers_and_comments(self, tmp_path: Path, lock: Path) -> None:
        root = _domains(
            tmp_path,
            geo=(
                "# PostGIS geometry columns on the DDL-imported tables.\n"
                "\n"
                "geoalchemy2==0.15.2  # trailing comment\n"
                "shapely[test]==2.0.6\n"
                'pyproj==3.6.1 ; python_version >= "3.13"\n'
            ),
        )
        assert dr.check(root, lock) == []

    def test_two_domains_may_share_a_dependency_at_one_version(
        self, tmp_path: Path, lock: Path
    ) -> None:
        root = _domains(tmp_path, geo="shapely==2.0.6\n", survey="shapely==2.0.6\n")
        assert dr.check(root, lock) == []


class TestShadowingACoreDependency:
    """The constraint the issue calls the one that matters most."""

    def test_a_core_dependency_cannot_be_restated(self, tmp_path: Path, lock: Path) -> None:
        root = _domains(tmp_path, geo="sqlalchemy==1.4.0\n")
        errors = dr.check(root, lock)
        assert len(errors) == 1
        assert "already resolved in uv.lock" in errors[0]
        assert "geo/requirements.txt:1" in errors[0]

    def test_not_even_at_the_same_version(self, tmp_path: Path, lock: Path) -> None:
        # A same-version restatement is harmless today and a silent downgrade the
        # day core's lock moves and the domain's copy does not.
        root = _domains(tmp_path, geo="sqlalchemy==2.0.36\n")
        assert len(dr.check(root, lock)) == 1

    def test_a_denormalized_spelling_cannot_evade_the_check(
        self, tmp_path: Path, lock: Path
    ) -> None:
        # PEP 503: `AWS.Lambda_Powertools` and `aws-lambda-powertools` are the
        # same distribution. Comparing raw strings would let the second copy in.
        root = _domains(tmp_path, geo="AWS.Lambda_Powertools==2.0.0\n")
        errors = dr.check(root, lock)
        assert len(errors) == 1
        assert "already resolved in uv.lock" in errors[0]

    def test_a_dev_group_dependency_counts_as_core(self, tmp_path: Path, lock: Path) -> None:
        root = _domains(tmp_path, geo="pytest==7.0.0\n")
        assert len(dr.check(root, lock)) == 1

    def test_normalization_is_pep503(self) -> None:
        assert dr.normalize("AWS.Lambda__Powertools") == "aws-lambda-powertools"

    def test_the_whole_lock_is_the_core_set(self, lock: Path) -> None:
        assert dr.locked_distributions(lock) == {
            "sqlalchemy",
            "aws-lambda-powertools",
            "pytest",
        }


class TestRejectedDeclarations:
    @pytest.mark.parametrize(
        "line",
        [
            "shapely",  # bare name — would float
            "shapely>=2.0.6",  # range — would float
            "shapely @ https://example.invalid/shapely.whl",  # unreviewable provenance
            "git+https://example.invalid/shapely.git#egg=shapely",
            "./vendor/shapely",
            "shapely===2.0.6",
        ],
    )
    def test_only_exact_pins_are_accepted(self, tmp_path: Path, lock: Path, line: str) -> None:
        root = _domains(tmp_path, geo=f"{line}\n")
        errors = dr.check(root, lock)
        assert len(errors) == 1
        assert "not an exactly-pinned requirement" in errors[0]

    @pytest.mark.parametrize(
        "line",
        [
            "--index-url https://example.invalid/simple",
            "--extra-index-url https://example.invalid/simple",
            "-i https://example.invalid/simple",
            "--find-links ./wheels",
            "--no-index",
            "-e ./local-package",
            "-r ../other/requirements.txt",
            "-c ./constraints.txt",
            "--trusted-host example.invalid",
        ],
    )
    def test_option_lines_are_refused(self, tmp_path: Path, lock: Path, line: str) -> None:
        root = _domains(tmp_path, geo=f"{line}\n")
        errors = dr.check(root, lock)
        assert len(errors) == 1
        assert "option line" in errors[0]

    def test_two_domains_disagreeing_on_a_version_is_an_error(
        self, tmp_path: Path, lock: Path
    ) -> None:
        root = _domains(tmp_path, alpha="shapely==2.0.6\n", zulu="shapely==2.1.0\n")
        errors = dr.check(root, lock)
        assert len(errors) == 1
        assert "conflicts with" in errors[0]
        assert "'alpha'" in errors[0]

    def test_every_bad_line_is_reported_not_just_the_first(
        self, tmp_path: Path, lock: Path
    ) -> None:
        root = _domains(tmp_path, geo="sqlalchemy==1.4.0\nshapely\n--no-index\n")
        assert len(dr.check(root, lock)) == 3


class TestCommandLine:
    def test_check_succeeds_on_the_real_tree(self) -> None:
        assert dr.main(["--check"]) == 0

    def test_list_prints_nothing_for_the_base_template(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        assert dr.main(["--list"]) == 0
        assert capsys.readouterr().out == ""

    def test_check_fails_and_explains(
        self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        monkeypatch.setattr(dr, "check", lambda: ["geo/requirements.txt:1: nope"])
        assert dr.main(["--check"]) == 1
        assert "geo/requirements.txt:1: nope" in capsys.readouterr().err

    def test_a_mode_is_required(self) -> None:
        with pytest.raises(SystemExit):
            dr.main([])
