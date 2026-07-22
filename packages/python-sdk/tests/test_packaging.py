"""Guards on what `biffo-plugin-sdk` publishes to PyPI.

This package is the ecosystem's public API contract: plugin manifests declare
``"biffo-plugin-sdk": "^1.0"`` and plugin ``pyproject.toml`` files pin
``>=1.0,<2.0`` (ADR-0003). Once 1.0.0 is on PyPI those pins are load-bearing,
so the things that make a release *correct* — the version line the release tag
is checked against, the declared public surface, the metadata PyPI requires,
and the typing marker — are asserted here rather than left to review.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

import biffo_plugin_sdk
import pytest

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
SRC = PACKAGE_ROOT / "src" / "biffo_plugin_sdk"


@pytest.fixture(scope="module")
def pyproject() -> dict:
    with (PACKAGE_ROOT / "pyproject.toml").open("rb") as handle:
        return tomllib.load(handle)


def test_version_is_independent_semver_at_or_above_1_0(pyproject: dict) -> None:
    """The SDK carries its own semver, not the template's core version.

    The floor matters: every plugin manifest and skeleton pyproject.toml in this
    repo already declares ^1.0 / >=1.0,<2.0, so publishing anything below 1.0.0
    would leave those declarations unsatisfiable, and anything at or above 2.0.0
    would silently stop satisfying them.

    It is also what now keeps the two lineages apart. The template's core version
    is pre-1.0 and, since #423, is not a file at all but its highest ``core-v*``
    git tag — so there is nothing left in the tree for this version to be
    accidentally inherited from, and wiring them together would have to move this
    line off 1.x and fail here.
    """
    version = pyproject["project"]["version"]
    major, minor, patch = (int(part) for part in version.split("."))
    assert major == 1, f"{version} does not satisfy the published >=1.0,<2.0 pin"
    assert minor >= 0 and patch >= 0


def test_declares_metadata_pypi_requires(pyproject: dict) -> None:
    project = pyproject["project"]
    for field in (
        "description",
        "readme",
        "license",
        "authors",
        "classifiers",
        "requires-python",
    ):
        assert project.get(field), f"missing packaging metadata: {field}"
    assert project["urls"]["Repository"].startswith("https://github.com/")


def test_readme_and_license_files_exist(pyproject: dict) -> None:
    """The readme/license-files metadata must point at files that are really there.

    hatchling fails the build on a missing readme, but license-files resolves to
    a possibly-empty glob — a typo there silently ships a wheel with no license.
    """
    assert (PACKAGE_ROOT / pyproject["project"]["readme"]).is_file()
    for pattern in pyproject["project"]["license-files"]:
        assert list(PACKAGE_ROOT.glob(pattern)), f"license-files matched nothing: {pattern}"


def test_py_typed_marker_backs_the_typed_classifier(pyproject: dict) -> None:
    """`Typing :: Typed` is a promise; PEP 561 requires the marker to keep it.

    Without py.typed a consumer's type checker ignores every annotation in this
    package, so the classifier would be claiming type information the SDK does
    not actually expose.
    """
    assert "Typing :: Typed" in pyproject["project"]["classifiers"]
    assert (SRC / "py.typed").is_file()


def test_wheel_packages_the_importable_package(pyproject: dict) -> None:
    """The distribution name and the import name differ, so this is explicit."""
    packages = pyproject["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"]
    assert packages == ["src/biffo_plugin_sdk"]
    assert pyproject["project"]["name"] == "biffo-plugin-sdk"


def test_public_surface_matches_dunder_all() -> None:
    """`__all__` is the 1.0.0 contract — it must match what is really exported.

    Catches both directions: a name listed but never imported (an ImportError
    for anyone doing `from biffo_plugin_sdk import *`), and a public name
    imported into the namespace without being declared, which third parties
    would start depending on without it ever being a deliberate commitment.
    """
    declared = set(biffo_plugin_sdk.__all__)
    actual = {
        name
        for name in vars(biffo_plugin_sdk)
        if not name.startswith("_")
        and getattr(vars(biffo_plugin_sdk)[name], "__module__", "").startswith("biffo_plugin_sdk")
    }
    assert declared == actual, f"undeclared: {actual - declared}; missing: {declared - actual}"


def test_dunder_all_is_sorted_and_unique() -> None:
    assert biffo_plugin_sdk.__all__ == sorted(set(biffo_plugin_sdk.__all__))


def test_every_exported_name_is_importable() -> None:
    for name in biffo_plugin_sdk.__all__:
        assert getattr(biffo_plugin_sdk, name, None) is not None, name


def test_sigv4_extra_keeps_botocore_optional(pyproject: dict) -> None:
    """`import biffo_plugin_sdk` must work without botocore installed.

    botocore is preinstalled in the Lambda runtime, so it is an extra rather
    than a hard dependency (ADR-0009) — which only holds while the SDK's
    imports of it stay lazy, i.e. inside function bodies.
    """
    project = pyproject["project"]
    assert "botocore" not in " ".join(project["dependencies"])
    assert any("botocore" in dep for dep in project["optional-dependencies"]["sigv4"])

    signed_client_source = (SRC / "signed_client.py").read_text()
    for line in signed_client_source.splitlines():
        if "botocore" in line and ("import " in line):
            assert line.startswith("    "), f"botocore imported at module scope: {line!r}"
