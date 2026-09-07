"""Guards on what `biffo-plugin-host` publishes to PyPI.

Mirrors `packages/python-sdk/tests/test_packaging.py`. This package is a
public API contract for third-party plugin repos (biffo-template#1922): a
plugin repo's own conformance checks import ``plugin_host.discover`` to
exercise the *real* host instead of mocking it. The things that make a
release correct — the version line the release tag is checked against, the
metadata PyPI requires, and the wheel packaging the importable module — are
asserted here rather than left to review.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
SRC = PACKAGE_ROOT / "src" / "plugin_host"


@pytest.fixture(scope="module")
def pyproject() -> dict:
    with (PACKAGE_ROOT / "pyproject.toml").open("rb") as handle:
        return tomllib.load(handle)


def test_version_is_independent_semver(pyproject: dict) -> None:
    """The host carries its own semver, not the template's core version.

    Unlike the SDK, there is no existing >=1.0 floor to respect: nothing
    consumes this package yet (M1 publishes it; M2 is the first consumer,
    see pyproject.toml's version comment), so a 0.x starting point is honest
    rather than a pin that would need satisfying. What this test guards is
    only that the version is real, parseable semver, not that it sits above
    any particular floor.
    """
    version = pyproject["project"]["version"]
    parts = version.split(".")
    assert len(parts) == 3, f"{version} is not major.minor.patch"
    major, minor, patch = (int(part) for part in parts)
    assert major >= 0 and minor >= 0 and patch >= 0


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

    hatchling fails the build on a missing readme, but license-files resolves
    to a possibly-empty glob — a typo there silently ships a wheel with no
    license.
    """
    assert (PACKAGE_ROOT / pyproject["project"]["readme"]).is_file()
    for pattern in pyproject["project"]["license-files"]:
        assert list(PACKAGE_ROOT.glob(pattern)), f"license-files matched nothing: {pattern}"


def test_wheel_packages_the_importable_package(pyproject: dict) -> None:
    """The distribution name and the import name differ, so this is explicit."""
    packages = pyproject["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"]
    assert packages == ["src/plugin_host"]
    assert pyproject["project"]["name"] == "biffo-plugin-host"


def test_public_import_surface_is_importable() -> None:
    """`from plugin_host.discover import discover_plugins, load_app` is the
    documented published contract (biffo-template#1922's done-when). Assert
    the names exist and are callable, not just that the module imports.
    """
    from plugin_host.discover import discover_plugins, load_app

    assert callable(discover_plugins)
    assert callable(load_app)


def test_sdk_dependency_pin_matches_the_version_the_host_actually_needs() -> None:
    """discover.py parses manifests through biffo_plugin_sdk.plugin.PluginManifest
    (biffo-template#1517) — the >=1.4 floor in pyproject.toml's dependencies is
    the SDK version where that model knows about user_ingress/admin_ingress and
    extra="forbid" gates a typo loudly. A regression here would silently widen
    what a published host wheel accepts as its SDK dependency.
    """
    project_root = Path(__file__).resolve().parent.parent
    with (project_root / "pyproject.toml").open("rb") as handle:
        data = tomllib.load(handle)
    deps = data["project"]["dependencies"]
    sdk_dep = next((d for d in deps if d.startswith("biffo-plugin-sdk")), None)
    assert sdk_dep is not None, "biffo-plugin-sdk dependency is missing"
    assert ">=1.4" in sdk_dep and "<2.0" in sdk_dep, sdk_dep
