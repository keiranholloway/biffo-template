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


# ── The generated result contract (ADR-0027 §6) ───────────────────────────────


def _rich_target() -> wb.WriteBackTarget:
    return _target(
        columns=(
            wb.WriteBackColumn(name="email", label="Email", type="email", required=True),
            wb.WriteBackColumn(name="notes", label="Notes", type="textarea"),
            wb.WriteBackColumn(
                name="rating", label="Rating", type="enum", values=("hot", "warm", "cold")
            ),
        ),
    )


def test_the_generated_schema_offers_exactly_the_declared_columns():
    wb.register_writeback_target(_rich_target())
    tool = wb.output_tool_for_writeback({"table": "leads", "columns": {"email": "x", "notes": "y"}})
    assert tool is not None
    fn = tool["function"]
    assert fn["name"] == "submit_leads_record"
    params = fn["parameters"]
    # `rating` was not declared by this workflow, so the model is never offered it.
    assert set(params["properties"]) == {"email", "notes"}
    assert params["required"] == ["email"]
    assert params["additionalProperties"] is False


def test_the_model_is_never_offered_a_column_outside_the_ceiling():
    wb.register_writeback_target(_rich_target())
    # Even if a declaration names something the target does not allow, the schema
    # is built from the *target*, so the extra column simply does not appear.
    tool = wb.output_tool_for_writeback(
        {"table": "leads", "columns": {"email": "x", "brand_id": "whatever"}}
    )
    assert tool is not None
    assert set(tool["function"]["parameters"]["properties"]) == {"email"}


def test_an_enum_column_constrains_the_models_choices():
    wb.register_writeback_target(_rich_target())
    tool = wb.output_tool_for_writeback({"table": "leads", "columns": {"rating": "x"}})
    assert tool is not None
    assert tool["function"]["parameters"]["properties"]["rating"]["enum"] == ["hot", "warm", "cold"]


def test_no_writeback_or_an_unregistered_table_generates_nothing():
    assert wb.output_tool_for_writeback(None) is None
    assert wb.output_tool_for_writeback({}) is None
    assert wb.output_tool_for_writeback({"table": "salaries", "columns": {"amount": "1"}}) is None


def test_apply_overrides_whatever_the_plugin_supplied():
    wb.register_writeback_target(_rich_target())
    snapshot = {
        "writeback": {"table": "leads", "columns": {"email": "x"}},
        # A plugin cannot decide the shape of a row Core is about to write.
        "output_tools": [{"function": {"name": "submit_anything", "parameters": {}}}],
    }
    applied = wb.apply_writeback_output_tool(snapshot)
    assert [t["function"]["name"] for t in applied["output_tools"]] == ["submit_leads_record"]
    # The original is not mutated — the run records what Core resolved.
    assert snapshot["output_tools"][0]["function"]["name"] == "submit_anything"


def test_a_snapshot_with_no_writeback_is_returned_untouched():
    snapshot = {"agent_name": "researcher", "output_tools": [{"function": {"name": "keep_me"}}]}
    assert wb.apply_writeback_output_tool(snapshot) is snapshot


# ── from_payload: a create's parent keys come from the trigger, not the model ──


def test_from_payload_requires_the_field_it_reads():
    """A derivation that names no field would silently resolve to nothing, and
    the column it guards is exactly the one that must not be guessable."""
    with pytest.raises(wb.WriteBackConfigurationError, match="names no payload field"):
        wb.DerivedValue(column="lead_id", kind="from_payload")


def test_from_payload_builds_a_derivation_bound_to_a_trigger_field():
    derived = wb.from_payload("lead_id", "lead_id")
    assert derived.kind == "from_payload"
    assert derived.payload_field == "lead_id"
    # Not scope-derived, so it places no requirement on a definition's scope —
    # the value comes from the event instead.
    assert _target(derived=(wb.from_payload("lead_id", "lead_id"),)).scope_levels == ()


def test_a_payload_derived_column_is_still_not_agent_writeable():
    """The guard that already refuses a column being both agent-writeable and
    Core-set applies to this kind too — otherwise declaring it would hand the
    model back the very column the derivation exists to keep from it."""
    with pytest.raises(wb.WriteBackConfigurationError):
        _target(
            columns=(wb.WriteBackColumn(name="lead_id", label="Lead", type="text"),),
            derived=(wb.from_payload("lead_id", "lead_id"),),
        )


# ── from_lookup: a create's Core-set value that only a database read can answer ─


def test_from_lookup_requires_a_resolver():
    """A derivation that names no resolver would silently resolve to nothing —
    and the column it guards is exactly the one that must never be guessable,
    let alone unset (#672)."""
    with pytest.raises(wb.WriteBackConfigurationError, match="names no resolver"):
        wb.DerivedValue(column="pipeline_stage_id", kind="from_lookup")


def test_from_lookup_builds_a_derivation_bound_to_a_resolver():
    async def _resolve(db: AsyncSession, tenant_id: str, scope: dict[str, Any] | None) -> Any:
        del db, tenant_id, scope
        return "onboarding"

    derived = wb.from_lookup("pipeline_stage_id", _resolve)
    assert derived.kind == "from_lookup"
    assert derived.resolver is _resolve
    # Not scope-derived, so it places no requirement on a definition's scope —
    # the value comes from a database read instead.
    assert _target(derived=(wb.from_lookup("pipeline_stage_id", _resolve),)).scope_levels == ()


def test_a_lookup_derived_column_is_still_not_agent_writeable():
    """The guard that already refuses a column being both agent-writeable and
    Core-set applies to this kind too — otherwise declaring it would hand the
    model back the very column the lookup exists to keep from it."""

    async def _resolve(db: AsyncSession, tenant_id: str, scope: dict[str, Any] | None) -> Any:
        del db, tenant_id, scope
        return "onboarding"

    with pytest.raises(wb.WriteBackConfigurationError, match="derived only"):
        _target(
            columns=(wb.WriteBackColumn(name="pipeline_stage_id", label="Stage"),),
            derived=(wb.from_lookup("pipeline_stage_id", _resolve),),
        )


class TestPiiRedaction:
    """#673: identifying values must not persist in AgentRun.result after the write."""

    def test_a_declared_sensitive_column_is_redactable(self):
        target = _target(
            columns=(
                wb.WriteBackColumn(name="notes", label="Notes", sensitive=True),
                wb.WriteBackColumn(name="stage", label="Stage"),
            ),
        )
        assert wb.redactable_columns(target) == frozenset({"notes"})

    def test_an_identifying_column_name_is_redactable_without_being_declared(self):
        # The half that covers targets nobody has annotated. The flag alone is
        # forgetful: every target that existed before #673 declares nothing.
        target = _target(
            columns=(
                wb.WriteBackColumn(name="email", label="Email"),
                wb.WriteBackColumn(name="phone_number", label="Phone"),
                wb.WriteBackColumn(name="pipeline_stage_id", label="Stage"),
            ),
        )
        assert wb.redactable_columns(target) == frozenset({"email", "phone_number"})

    def test_free_text_is_not_redacted_by_name(self):
        # Deliberate. `notes` is where PII hides, but it is also where the
        # explanation lives, and a run record scrubbed of its reasoning stops being
        # auditable. Free text is the case for the explicit flag, not the heuristic.
        target = _target(columns=(wb.WriteBackColumn(name="notes", label="Notes"),))
        assert wb.redactable_columns(target) == frozenset()

    def test_the_pii_list_is_not_the_secrets_list(self):
        """These two must never be merged, and the reason is a shipped feature.

        `_SENSITIVE_SUBSTRINGS` feeds `events/event_fields.py`, which derives the
        orchestration trigger-field catalogue. Adding `email`/`phone` there would
        strip them from state-change payloads and from the trigger fields the UI
        offers — silently breaking recipient-field templating, which sends to
        `{email}` and relies on `DemoRequestedPayload` carrying it (and, in an
        instance, on its own registered events carrying it the same way — see
        `lead.captured` in tabsii's `domains/tabsii/`, #848).
        """
        from api.routing.crud_handlers import _SENSITIVE_SUBSTRINGS

        assert "email" not in _SENSITIVE_SUBSTRINGS
        assert "phone" not in _SENSITIVE_SUBSTRINGS
        # And the PII list must not have absorbed the secrets, which would make the
        # separation cosmetic.
        assert "token" not in wb.PII_NAME_SUBSTRINGS
        assert "password" not in wb.PII_NAME_SUBSTRINGS
