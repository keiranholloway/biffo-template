"""User-facing and admin-facing plugin surface declarations: manifest schema."""

from __future__ import annotations

import pytest
from api.models.plugin_user_surface import (
    AdminIngress,
    UserFrontend,
    UserIngress,
    parse_admin_ingress_from_manifest,
    parse_user_frontend_from_manifest,
    parse_user_ingress_from_manifest,
)
from pydantic import ValidationError

# ── user_ingress ─────────────────────────────────────────────────────────────────


def test_user_ingress_parses_an_app_ref_the_shared_host_mounts():
    ingress = UserIngress(required_group="founder", app="ideation.app:app")
    assert ingress.app == "ideation.app:app"
    assert ingress.required_group == "founder"


def test_user_ingress_requires_a_group_and_an_app_ref():
    with pytest.raises(ValidationError):
        UserIngress(required_group="  ", app="ideation.app:app")
    # app is required — a plugin has no ingress the host can mount without it
    with pytest.raises(ValidationError):
        UserIngress.model_validate({"required_group": "founder"})


def test_user_ingress_rejects_a_malformed_app_ref():
    for bad in ("nocolon", "mod:", ":attr", "1bad:app", "mod:1bad"):
        with pytest.raises(ValidationError):
            UserIngress(required_group="founder", app=bad)


def test_user_ingress_rejects_unknown_keys():
    # extra="forbid": a typo'd key on a security surface fails loudly. This also
    # rejects the removed legacy `handler`/`path` keys (ADR-0018).
    for extra in ({"public": True}, {"handler": "x.y"}, {"path": "api"}):
        with pytest.raises(ValidationError):
            UserIngress.model_validate({"required_group": "founder", "app": "m:a", **extra})


# ── admin_ingress ────────────────────────────────────────────────────────────


def test_admin_ingress_parses_an_app_ref_the_shared_host_mounts():
    ingress = AdminIngress(required_group="admin", app="ideation.admin:app")
    assert ingress.app == "ideation.admin:app"
    assert ingress.required_group == "admin"


def test_admin_ingress_requires_a_group_and_an_app_ref():
    with pytest.raises(ValidationError):
        AdminIngress(required_group="  ", app="ideation.admin:app")
    # app is required
    with pytest.raises(ValidationError):
        AdminIngress.model_validate({"required_group": "admin"})


def test_admin_ingress_rejects_a_malformed_app_ref():
    for bad in ("nocolon", "mod:", ":attr", "1bad:app", "mod:1bad"):
        with pytest.raises(ValidationError):
            AdminIngress(required_group="admin", app=bad)


def test_admin_ingress_rejects_unknown_keys():
    # extra="forbid": a typo'd key on a security surface fails loudly.
    with pytest.raises(ValidationError):
        AdminIngress.model_validate({"required_group": "admin", "app": "m:a", "extra": True})


# ── user_frontend ────────────────────────────────────────────────────────────────


def test_user_frontend_parses():
    fe = UserFrontend(dir="web/dist", required_group="founder")
    assert fe.dir == "web/dist"


def test_user_frontend_dir_must_be_relative_no_traversal():
    for bad in ("/etc/passwd", "../secrets", "web/../../x", ""):
        with pytest.raises(ValidationError):
            UserFrontend(dir=bad, required_group="founder")


# ── piecemeal parsing ────────────────────────────────────────────────────────────


def test_parsers_return_none_when_absent():
    assert parse_user_ingress_from_manifest({}) is None
    assert parse_admin_ingress_from_manifest({}) is None
    assert parse_user_frontend_from_manifest({}) is None


def test_parsers_build_the_models_when_present():
    manifest = {
        "user_ingress": {"required_group": "founder", "app": "ideation.app:app"},
        "admin_ingress": {"required_group": "admin", "app": "ideation.admin:app"},
        "user_frontend": {"dir": "web/dist", "required_group": "founder"},
    }
    ingress = parse_user_ingress_from_manifest(manifest)
    admin_ingress = parse_admin_ingress_from_manifest(manifest)
    frontend = parse_user_frontend_from_manifest(manifest)
    assert ingress is not None and ingress.app == "ideation.app:app"
    assert admin_ingress is not None and admin_ingress.app == "ideation.admin:app"
    assert frontend is not None and frontend.dir == "web/dist"
