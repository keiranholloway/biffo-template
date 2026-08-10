"""The media generation cost ledger — internal write, admin read.

Text spend is already recorded well on ``agent_runs``. This table exists for the
half the agent runtime structurally cannot hold, so the tests here concentrate on
the three things that make a billing ledger trustworthy:

* attribution cannot be forged by the caller,
* an unpriced generation stays visibly unpriced rather than reading as free,
* one tenant cannot see another's spend.

In-memory SQLite + dependency overrides, mirroring
``test_admin_agent_runs_router.py``.
"""

import asyncio
from collections.abc import AsyncGenerator, Generator

import pytest
from api.database import get_db
from api.dependencies import require_admin
from api.middleware.auth import AuthenticatedUser
from api.middleware.service_auth import ServicePrincipal, require_service_principal
from api.models.base import Base
from api.models.media_generation import MediaGeneration  # noqa: F401 — registers the table
from api.routers import internal_media_generations
from api.routers.admin import media_generations as admin_media_generations
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

_WRITE = "/api/v1/internal/media-generations"
_READ = "/api/v1/admin/media-generations"

_HOST_PLUGIN = ServicePrincipal(
    principal_arn="arn:aws:sts::123456789012:assumed-role/test-host-role/session",
    asserted_plugin="marketing",
)


def _admin(tenant_id: str = "default") -> AuthenticatedUser:
    return AuthenticatedUser(
        sub="admin-sub",
        email="admin@example.com",
        username="admin",
        tenant_id=tenant_id,
        roles=["admin"],
    )


@pytest.fixture
def ctx() -> Generator[dict]:
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )

    async def _create() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_create())
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_get_db() -> AsyncGenerator[AsyncSession]:
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app = FastAPI()
    app.include_router(internal_media_generations.router, prefix="/api/v1")
    app.include_router(admin_media_generations.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[require_service_principal] = lambda: _HOST_PLUGIN
    app.dependency_overrides[require_admin] = lambda: _admin()

    yield {"app": app, "client": TestClient(app), "sessions": session_factory}
    asyncio.run(engine.dispose())


def _body(**overrides) -> dict:
    body = {
        "media_kind": "image",
        "provider": "openai",
        "model": "gpt-image-1",
        "units": 1,
        "unit_kind": "image",
        "cost_usd": 0.04,
    }
    body.update(overrides)
    return body


# --- write side -----------------------------------------------------------


def test_records_a_generation(ctx):
    resp = ctx["client"].post(_WRITE, json=_body())
    assert resp.status_code == 201, resp.text
    assert resp.json()["id"]

    listed = ctx["client"].get(_READ).json()["media_generations"]
    assert len(listed) == 1
    row = listed[0]
    assert (row["provider"], row["model"], row["media_kind"]) == ("openai", "gpt-image-1", "image")
    assert row["units"] == 1
    assert row["unit_kind"] == "image"
    assert row["cost_usd"] == 0.04


def test_attribution_comes_from_the_principal_not_the_body(ctx):
    """The one property a billing ledger cannot give up.

    A caller able to name itself could attribute its spend to another plugin,
    which makes every per-plugin total meaningless and does so silently.
    """
    resp = ctx["client"].post(_WRITE, json=_body(caller_plugin="system:some-other-plugin"))
    assert resp.status_code == 201, resp.text

    row = ctx["client"].get(_READ).json()["media_generations"][0]
    assert row["caller_plugin"] == "system:marketing"


def test_an_isolated_plugin_is_attributed_from_its_role(ctx):
    """The case an `asserted_plugin`-only implementation would silently miss.

    An `isolated: true` plugin never goes through the shared host, so it has no
    asserted identity — only its role ARN. Reading `logical_names` is what makes
    both work, and this pins that choice.
    """
    ctx["app"].dependency_overrides[require_service_principal] = lambda: ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/biffo-dev-plugin-scout-role/s"
    )
    assert ctx["client"].post(_WRITE, json=_body()).status_code == 201
    row = ctx["client"].get(_READ).json()["media_generations"][0]
    assert row["caller_plugin"] == "system:scout"


def test_a_non_plugin_caller_is_recorded_as_null(ctx):
    """Rather than forced into a plugin-shaped answer it cannot support."""
    ctx["app"].dependency_overrides[require_service_principal] = lambda: ServicePrincipal(
        principal_arn="arn:aws:iam::123456789012:user/some-human"
    )
    assert ctx["client"].post(_WRITE, json=_body()).status_code == 201
    assert ctx["client"].get(_READ).json()["media_generations"][0]["caller_plugin"] is None


def test_an_unknown_media_kind_is_rejected(ctx):
    """Not merely stored.

    A kind nothing recognises would sit in the ledger contributing to no rollup
    and appearing in no report — indistinguishable from not having recorded it,
    while looking like success.
    """
    resp = ctx["client"].post(_WRITE, json=_body(media_kind="hologram"))
    assert resp.status_code == 422
    assert ctx["client"].get(_READ).json()["media_generations"] == []


def test_zero_units_is_rejected(ctx):
    """A generation that consumed nothing is a bug in the caller, not a fact."""
    assert ctx["client"].post(_WRITE, json=_body(units=0)).status_code == 422


def test_fractional_units_survive(ctx):
    """3.5 seconds of video is a real quantity.

    Rounding it at write time is irreversible: the original number is gone and
    no later normalisation can recover it.
    """
    assert (
        ctx["client"]
        .post(_WRITE, json=_body(media_kind="video", units=3.5, unit_kind="second"))
        .status_code
        == 201
    )
    assert ctx["client"].get(_READ).json()["media_generations"][0]["units"] == 3.5


# --- cost aggregation -----------------------------------------------------


def test_costs_group_by_caller_provider_model_and_unit(ctx):
    c = ctx["client"]
    c.post(_WRITE, json=_body())
    c.post(_WRITE, json=_body())
    c.post(_WRITE, json=_body(media_kind="video", units=3, unit_kind="second", cost_usd=0.30))

    rows = c.get(f"{_READ}/costs").json()
    by_kind = {r["media_kind"]: r for r in rows}
    assert by_kind["image"]["generations"] == 2
    assert by_kind["image"]["total_units"] == 2
    assert by_kind["image"]["total_cost_usd"] == pytest.approx(0.08)
    assert by_kind["video"]["unit_kind"] == "second"
    assert by_kind["video"]["total_units"] == 3


def test_an_unpriced_generation_is_counted_not_treated_as_free(ctx):
    """The assertion this whole file exists for.

    A provider returning no price leaves cost_usd NULL, which is a different
    fact from a generation that was genuinely free. Folding NULL into the total
    as zero produces a confident number over a denominator nobody stated — the
    error `aggregate_run_costs` already guards against with `unpriced_runs`, and
    the reason this reports `unpriced` beside every total.
    """
    c = ctx["client"]
    c.post(_WRITE, json=_body(cost_usd=0.04))
    c.post(_WRITE, json=_body(cost_usd=None))

    (row,) = c.get(f"{_READ}/costs").json()
    assert row["generations"] == 2
    assert row["unpriced"] == 1
    # The priced one only. The unpriced generation did not silently contribute 0.
    assert row["total_cost_usd"] == pytest.approx(0.04)
    # Units are still counted — we know how much was made, just not what it cost.
    assert row["total_units"] == 2


def test_a_genuinely_free_generation_is_not_counted_as_unpriced(ctx):
    """0.0 and NULL must not collapse into each other.

    If they did, "this provider is free" and "we could not price this provider"
    would be the same report.
    """
    ctx["client"].post(_WRITE, json=_body(cost_usd=0))
    (row,) = ctx["client"].get(f"{_READ}/costs").json()
    assert row["unpriced"] == 0
    assert row["total_cost_usd"] == 0


def test_costs_can_be_filtered_by_caller(ctx):
    c = ctx["client"]
    c.post(_WRITE, json=_body())
    ctx["app"].dependency_overrides[require_service_principal] = lambda: ServicePrincipal(
        principal_arn="arn:aws:sts::123456789012:assumed-role/biffo-dev-plugin-scout-role/s"
    )
    c.post(_WRITE, json=_body())

    rows = c.get(f"{_READ}/costs", params={"caller_plugin": "system:marketing"}).json()
    assert len(rows) == 1
    assert rows[0]["caller_plugin"] == "system:marketing"


# --- isolation ------------------------------------------------------------


def test_another_tenants_spend_is_invisible(ctx):
    ctx["client"].post(_WRITE, json=_body())
    ctx["app"].dependency_overrides[require_admin] = lambda: _admin(tenant_id="other-tenant")

    assert ctx["client"].get(_READ).json()["media_generations"] == []
    assert ctx["client"].get(f"{_READ}/costs").json() == []


def test_the_list_echoes_its_paging(ctx):
    body = ctx["client"].get(_READ, params={"limit": 5, "offset": 2}).json()
    assert (body["limit"], body["offset"]) == (5, 2)


def test_paging_bounds_are_enforced(ctx):
    assert ctx["client"].get(_READ, params={"limit": 0}).status_code == 422
    assert ctx["client"].get(_READ, params={"limit": 201}).status_code == 422
    assert ctx["client"].get(_READ, params={"offset": -1}).status_code == 422
