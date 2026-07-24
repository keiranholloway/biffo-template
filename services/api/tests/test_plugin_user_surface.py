"""User-facing plugin surface declarations (ADR-0018): manifest schema."""

from __future__ import annotations

import pytest
from api.models.plugin_user_surface import (
    UserFrontend,
    UserIngress,
    parse_user_frontend_from_manifest,
    parse_user_ingress_from_manifest,
)
from pydantic import ValidationError

# ── user_ingress ─────────────────────────────────────────────────────────────────


def test_user_ingress_parses_with_defaults():
    ingress = UserIngress(required_group="founder", handler="ideation.lambda.handler")
    assert ingress.path == "api"  # default segment
    assert ingress.required_group == "founder"


def test_user_ingress_path_must_be_a_single_segment():
    for bad in ("api/v1", "/api", "Api", ""):
        with pytest.raises(ValidationError):
            UserIngress(path=bad, required_group="founder", handler="x.y")


def test_user_ingress_requires_a_group_and_a_dotted_handler():
    with pytest.raises(ValidationError):
        UserIngress(required_group="  ", handler="x.y")
    for bad_handler in ("nothandler", "1.bad", "a..b"):
        with pytest.raises(ValidationError):
            UserIngress(required_group="founder", handler=bad_handler)


def test_user_ingress_accepts_an_app_ref_the_shared_host_mounts():
    # ADR-0021: `app` names the ASGI app the shared plugin host mounts; no handler.
    ingress = UserIngress(required_group="founder", app="ideation.app:app")
    assert ingress.app == "ideation.app:app"
    assert ingress.handler is None


def test_user_ingress_rejects_a_malformed_app_ref():
    for bad in ("nocolon", "mod:", ":attr", "1bad:app", "mod:1bad"):
        with pytest.raises(ValidationError):
            UserIngress(required_group="founder", app=bad)


def test_user_ingress_requires_app_or_handler():
    # neither declared → the plugin has no ingress the host can mount
    with pytest.raises(ValidationError):
        UserIngress(required_group="founder")


def test_user_ingress_rejects_unknown_keys():
    # extra="forbid": a typo'd key on a security surface fails loudly. Built via a
    # dict so the deliberately-unknown key isn't a static type error.
    with pytest.raises(ValidationError):
        UserIngress.model_validate({"required_group": "founder", "handler": "x.y", "public": True})


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
    assert parse_user_frontend_from_manifest({}) is None


def test_parsers_build_the_models_when_present():
    manifest = {
        "user_ingress": {
            "path": "api",
            "required_group": "founder",
            "handler": "ideation.lambda.handler",
        },
        "user_frontend": {"dir": "web/dist", "required_group": "founder"},
    }
    ingress = parse_user_ingress_from_manifest(manifest)
    frontend = parse_user_frontend_from_manifest(manifest)
    assert ingress is not None and ingress.handler == "ideation.lambda.handler"
    assert frontend is not None and frontend.dir == "web/dist"
