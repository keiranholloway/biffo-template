"""Unit tests for the write-back target registry and the principal-session seam
(ADR-0027 §3 term 1, and §2's binding).

The registration-time rejections below are the ceiling's real enforcement: every
one of them is a shape that would look plausible in review and be unsafe at run
time, so each fails the deploy instead.
"""

from __future__ import annotations

from typing import Any, cast

import pytest
from api import writeback_targets as wb
from sqlalchemy.ext.asyncio import AsyncSession

_DB = cast(AsyncSession, None)


class _FakeModel:
    """Stands in for a mapped model; the registry only ever holds the reference."""


@pytest.fixture(autouse=True)
def _reset_registry():
    saved_targets = dict(wb._targets)  # noqa: SLF001
    saved_provider = wb._provider  # noqa: SLF001
    yield
    wb._targets.clear()  # noqa: SLF001
    wb._targets.update(saved_targets)  # noqa: SLF001
    wb._provider = saved_provider  # noqa: SLF001


def _target(**overrides: Any) -> wb.WriteBackTarget:
    kwargs: dict[str, Any] = {
        "table": "leads",
        "model": _FakeModel,
        "label": "Lead",
        "permission_code": "leads.create",
        "allowed_principals": ("system:orchestrator",),
        "columns": (wb.WriteBackColumn(name="notes", label="Notes", type="textarea"),),
        "operations": ("create",),
        "derived": (wb.from_tenant(), wb.from_scope("brand_id", "brand")),
    }
    kwargs.update(overrides)
    return wb.WriteBackTarget(**kwargs)


# ── The ceiling starts empty ──────────────────────────────────────────────────


def test_registry_is_empty_by_default_so_nothing_is_writeable():
    wb._targets.clear()  # noqa: SLF001
    assert wb.registered_writeback_targets() == ()
    assert wb.resolve_writeback_target("leads") is None


def test_registration_round_trips_and_replaces_by_table():
    first = wb.register_writeback_target(_target(label="Lead"))
    assert wb.resolve_writeback_target("leads") is first

    second = wb.register_writeback_target(_target(label="Lead (revised)"))
    assert wb.resolve_writeback_target("leads") is second
    assert len([t for t in wb.registered_writeback_targets() if t.table == "leads"]) == 1


# ── Registration-time rejections ──────────────────────────────────────────────


def test_rejects_a_reserved_column_an_agent_must_never_set():
    for reserved in ("id", "tenant_id", "created_at", "updated_at", "deleted_at"):
        with pytest.raises(wb.WriteBackConfigurationError, match="Core always sets"):
            _target(columns=(wb.WriteBackColumn(name=reserved, label=reserved),))


def test_rejects_a_column_that_is_both_agent_writeable_and_derived():
    # brand_id decides the authorization outcome for tabsii's leads policy. A
    # target naming it in both sets would let the model choose its own scope.
    with pytest.raises(wb.WriteBackConfigurationError, match="derived only"):
        _target(
            columns=(wb.WriteBackColumn(name="brand_id", label="Brand"),),
            derived=(wb.from_scope("brand_id", "brand"),),
        )


def test_rejects_delete_and_any_other_unknown_operation():
    with pytest.raises(wb.WriteBackConfigurationError, match="not offered by design"):
        _target(operations=("create", "delete"))


def test_rejects_no_operations_and_no_columns():
    with pytest.raises(wb.WriteBackConfigurationError, match="declares no operations"):
        _target(operations=())
    with pytest.raises(wb.WriteBackConfigurationError, match="no writeable columns"):
        _target(columns=())


def test_update_requires_a_row_selector():
    with pytest.raises(wb.WriteBackConfigurationError, match="no row_selector"):
        _target(operations=("update",))

    allowed = _target(operations=("update",), row_selector=wb.RowSelector(payload_field="lead_id"))
    assert allowed.row_selector is not None


def test_a_create_only_target_may_not_carry_a_dead_row_selector():
    with pytest.raises(wb.WriteBackConfigurationError, match="dead config"):
        _target(operations=("create",), row_selector=wb.RowSelector(payload_field="lead_id"))


def test_rejects_principals_a_derived_name_could_never_match():
    with pytest.raises(wb.WriteBackConfigurationError, match="system:<name>"):
        _target(allowed_principals=("orchestrator",))
    with pytest.raises(wb.WriteBackConfigurationError, match="system:<name>"):
        _target(allowed_principals=("system:",))
    with pytest.raises(wb.WriteBackConfigurationError, match="dead config"):
        _target(allowed_principals=())


def test_rejects_a_target_with_no_permission_code():
    with pytest.raises(wb.WriteBackConfigurationError, match="no permission_code"):
        _target(permission_code="")


def test_rejects_duplicate_columns_and_unknown_column_shapes():
    with pytest.raises(wb.WriteBackConfigurationError, match="more than once"):
        _target(
            columns=(
                wb.WriteBackColumn(name="notes", label="Notes"),
                wb.WriteBackColumn(name="notes", label="Notes again"),
            )
        )
    with pytest.raises(wb.WriteBackConfigurationError, match="unknown type"):
        wb.WriteBackColumn(name="notes", label="Notes", type="blob")
    with pytest.raises(wb.WriteBackConfigurationError, match="unknown overwrite mode"):
        wb.WriteBackColumn(name="notes", label="Notes", overwrite="clobber")
    with pytest.raises(wb.WriteBackConfigurationError, match="declares no values"):
        wb.WriteBackColumn(name="status", label="Status", type="enum")


def test_rejects_a_from_scope_derivation_with_no_level():
    with pytest.raises(wb.WriteBackConfigurationError, match="names no level"):
        wb.DerivedValue(column="brand_id", kind="from_scope")
    with pytest.raises(wb.WriteBackConfigurationError, match="unknown kind"):
        wb.DerivedValue(column="brand_id", kind="from_wherever")


# ── Accessors the router and executor rely on ─────────────────────────────────


def test_scope_levels_reports_what_a_definition_must_carry():
    assert _target().scope_levels == ("brand",)
    # Nothing scope-derived, so an unscoped definition is fine here.
    assert _target(derived=(wb.from_tenant(),)).scope_levels == ()


def test_allows_matches_only_a_named_principal():
    target = _target()
    assert target.allows(frozenset({"system:orchestrator"})) is True
    assert target.allows(frozenset({"system:agent-runtime"})) is False
    assert target.allows(frozenset()) is False


def test_column_lookup_and_names():
    target = _target()
    assert target.column_names == ("notes",)
    assert target.column("notes") is not None
    assert target.column("email") is None


def test_overwrite_defaults_to_not_clobbering_a_human_value():
    assert wb.WriteBackColumn(name="notes", label="Notes").overwrite == "if_empty"


# ── The principal-session seam ────────────────────────────────────────────────


async def test_default_provider_refuses_because_the_template_has_no_rls():
    assert await wb.bind_principal_session(_DB, "user-1") is False


async def test_a_registered_provider_is_consulted_with_the_stored_user_id():
    seen: list[str] = []

    async def provider(db: AsyncSession, user_id: str) -> bool:
        del db
        seen.append(user_id)
        return True

    wb.register_principal_session_provider(provider)
    assert await wb.bind_principal_session(_DB, "user-1") is True
    assert seen == ["user-1"]


async def test_a_provider_that_raises_is_a_refusal_not_a_pass():
    async def provider(db: AsyncSession, user_id: str) -> bool:
        del db, user_id
        raise RuntimeError("no such session")

    wb.register_principal_session_provider(provider)
    assert await wb.bind_principal_session(_DB, "user-1") is False


async def test_an_absent_user_id_never_reaches_the_provider():
    async def provider(db: AsyncSession, user_id: str) -> bool:
        del db, user_id
        raise AssertionError("must not be consulted without a principal")

    wb.register_principal_session_provider(provider)
    assert await wb.bind_principal_session(_DB, "") is False
