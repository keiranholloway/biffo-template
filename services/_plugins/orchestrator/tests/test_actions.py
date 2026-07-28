"""Tests for the action handlers (email, Google Chat, WhatsApp, agent, fan-in)."""

from __future__ import annotations

from typing import Any

import pytest
from orchestrator.actions import (
    ACTION_HANDLERS,
    ActionError,
    TransientActionError,
    WhatsAppSettings,
    fan_in_agent_runs,
    prepare_delivery,
    request_agent_run,
    send_email,
    send_google_chat,
    send_slack,
    send_whatsapp,
)
from orchestrator_fakes import FakeCore, FakeHttp, FakeSes, FlakyHttp, FlakySes


def test_send_email_renders_templates_and_sends():
    ses = FakeSes()

    result = send_email(
        {
            "from": "no-reply@example.com",
            "to": "sales@example.com",
            "subject": "New demo from {company}",
            "body": "Contact: {email}",
        },
        {"company": "Acme", "email": "lead@acme.com"},
        ses_client=ses,
    )

    assert result == {"message_id": "ses-message-1"}
    call = ses.calls[0]
    assert call["Source"] == "no-reply@example.com"
    assert call["Destination"]["ToAddresses"] == ["sales@example.com"]
    assert call["Message"]["Subject"]["Data"] == "New demo from Acme"
    assert call["Message"]["Body"]["Text"]["Data"] == "Contact: lead@acme.com"


def test_missing_template_field_renders_empty():
    ses = FakeSes()

    send_email({"from": "f@x", "to": "t@x", "subject": "Hi {missing}"}, {}, ses_client=ses)

    assert ses.calls[0]["Message"]["Subject"]["Data"] == "Hi "


def test_list_of_recipients():
    ses = FakeSes()

    send_email({"from": "f@x", "to": ["a@x", "b@x"]}, {}, ses_client=ses)

    assert ses.calls[0]["Destination"]["ToAddresses"] == ["a@x", "b@x"]


def test_missing_required_key_raises_action_error():
    with pytest.raises(ActionError, match="missing required key"):
        send_email({"from": "f@x"}, {}, ses_client=FakeSes())


def test_send_email_renders_templated_recipient():
    ses = FakeSes()

    send_email(
        {"from": "f@x", "to": "{email}", "subject": "s", "body": "b"},
        {"email": "lead@acme.com"},
        ses_client=ses,
    )

    assert ses.calls[0]["Destination"]["ToAddresses"] == ["lead@acme.com"]


def test_send_email_literal_recipient_unaffected_by_rendering():
    ses = FakeSes()

    send_email(
        {"from": "f@x", "to": "fixed@example.com", "subject": "s", "body": "b"},
        {"email": "lead@acme.com"},
        ses_client=ses,
    )

    assert ses.calls[0]["Destination"]["ToAddresses"] == ["fixed@example.com"]


def test_send_email_recipient_template_missing_field_raises_action_error():
    ses = FakeSes()

    with pytest.raises(ActionError, match="rendered empty"):
        send_email(
            {"from": "f@x", "to": "{missing}", "subject": "s", "body": "b"},
            {},
            ses_client=ses,
        )

    assert ses.calls == []


# ── Google Chat ──────────────────────────────────────────────────────────────


def test_send_google_chat_posts_rendered_text():
    http = FakeHttp(status_code=200)

    result = send_google_chat(
        {
            "webhook_url": "https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k",
            "message": "New demo from {company} ({email})",
        },
        {"company": "Acme", "email": "lead@acme.com"},
        http_client=http,
    )

    assert result == {"status_code": 200}
    call = http.calls[0]
    assert call["url"].startswith("https://chat.googleapis.com/")
    assert call["json"] == {"text": "New demo from Acme (lead@acme.com)"}


def test_send_google_chat_requires_webhook_url():
    with pytest.raises(ActionError, match="missing required key"):
        send_google_chat({"message": "hi"}, {}, http_client=FakeHttp())


def test_send_google_chat_non_2xx_is_action_error():
    http = FakeHttp(status_code=404, text="not found")
    with pytest.raises(ActionError, match="Google Chat webhook failed: 404"):
        send_google_chat(
            {"webhook_url": "https://chat.googleapis.com/x", "message": "hi"},
            {},
            http_client=http,
        )


# ── Slack (ADR-0020): incoming-webhook POST, mirrors Google Chat ─────────────


def test_send_slack_posts_rendered_text():
    http = FakeHttp(status_code=200)

    result = send_slack(
        {
            "webhook_url": "https://hooks.slack.com/services/T/B/x",
            "message": "New demo from {company} ({email})",
        },
        {"company": "Acme", "email": "lead@acme.com"},
        http_client=http,
    )

    assert result == {"status_code": 200}
    call = http.calls[0]
    assert call["url"] == "https://hooks.slack.com/services/T/B/x"
    assert call["json"] == {"text": "New demo from Acme (lead@acme.com)"}


def test_send_slack_requires_webhook_url():
    with pytest.raises(ActionError, match="missing required key"):
        send_slack({"message": "hi"}, {}, http_client=FakeHttp())


def test_send_slack_non_2xx_is_action_error():
    http = FakeHttp(status_code=404, text="no channel")
    with pytest.raises(ActionError, match="Slack webhook failed: 404"):
        send_slack(
            {"webhook_url": "https://hooks.slack.com/x", "message": "hi"}, {}, http_client=http
        )


def test_slack_is_a_registered_action():
    assert ACTION_HANDLERS["slack"] is send_slack


# ── prepare_delivery (ADR-0020): render an agent result into a destination ───


def _completed_run(result, delivery, **over):
    run = {
        "id": "agent-run-9",
        "agent_name": "demo-enricher",
        "status": "completed",
        "result": result,
        "definition_snapshot": {"delivery": delivery} if delivery else {},
    }
    run.update(over)
    return run


def test_prepare_delivery_defaults_body_to_output_placeholder():
    delivery = {"type": "slack", "config": {"webhook_url": "https://hooks.slack.com/x"}}
    run = _completed_run({"output": "the verdict"}, delivery)

    prepared = prepare_delivery(delivery, run)
    assert prepared is not None
    action_type, config, payload = prepared
    assert action_type == "slack"
    # No message was configured, so it defaults to the {output} placeholder…
    assert config["message"] == "{output}"
    # …and the render payload carries the agent's output plus run metadata.
    assert payload["output"] == "the verdict"
    assert payload["agent"] == "demo-enricher"
    assert payload["run_id"] == "agent-run-9"


def test_prepare_delivery_keeps_an_authored_template():
    delivery = {
        "type": "slack",
        "config": {"webhook_url": "https://hooks.slack.com/x", "message": "Result: {output}"},
    }
    run = _completed_run({"output": "done"}, delivery)
    prepared = prepare_delivery(delivery, run)
    assert prepared is not None
    _, config, _ = prepared
    assert config["message"] == "Result: {output}"


def test_prepare_delivery_renders_through_the_executor():
    """The executor renders {output} from the payload — the whole point of reusing
    it: a delivery template fills exactly as an event-payload template does."""
    delivery = {
        "type": "slack",
        "config": {"webhook_url": "https://hooks.slack.com/x", "message": "Result: {output}"},
    }
    run = _completed_run({"output": "42"}, delivery)
    prepared = prepare_delivery(delivery, run)
    assert prepared is not None
    _, config, payload = prepared

    http = FakeHttp(status_code=200)
    send_slack(config, payload, http_client=http)
    assert http.calls[0]["json"] == {"text": "Result: 42"}


def test_prepare_delivery_serialises_a_tool_shaped_result():
    """A submit-tool result has no plain `output`; the whole result is serialised
    rather than delivering nothing."""
    delivery = {"type": "slack", "config": {"webhook_url": "https://hooks.slack.com/x"}}
    run = _completed_run({"output_tool": "submit", "arguments": {"verdict": "go"}}, delivery)
    prepared = prepare_delivery(delivery, run)
    assert prepared is not None
    _, _, payload = prepared
    assert "verdict" in payload["output"]


def test_prepare_delivery_none_when_no_delivery():
    assert prepare_delivery(None, _completed_run({"output": "x"}, None)) is None


def test_prepare_delivery_none_for_unknown_type():
    delivery = {"type": "carrier-pigeon", "config": {}}
    assert prepare_delivery(delivery, _completed_run({"output": "x"}, delivery)) is None


# ── WhatsApp ─────────────────────────────────────────────────────────────────

_WA = WhatsAppSettings(access_token="tok-123", phone_number_id="pn-456")


def test_send_whatsapp_posts_to_cloud_api_with_bearer():
    http = FakeHttp(status_code=200, json_data={"messages": [{"id": "wamid.ABC"}]})

    result = send_whatsapp(
        {"to": "+15551234567", "message": "Hi {name}"},
        {"name": "Sam"},
        http_client=http,
        whatsapp=_WA,
    )

    assert result == {"message_id": "wamid.ABC"}
    call = http.calls[0]
    assert call["url"] == "https://graph.facebook.com/v22.0/pn-456/messages"
    assert call["headers"]["Authorization"] == "Bearer tok-123"
    assert call["json"] == {
        "messaging_product": "whatsapp",
        "to": "+15551234567",
        "type": "text",
        "text": {"body": "Hi Sam"},
    }


def test_send_whatsapp_unconfigured_is_action_error():
    with pytest.raises(ActionError, match="WhatsApp is not configured"):
        send_whatsapp(
            {"to": "+1", "message": "hi"},
            {},
            http_client=FakeHttp(),
            whatsapp=WhatsAppSettings(access_token="", phone_number_id=""),
        )


def test_send_whatsapp_requires_recipient():
    with pytest.raises(ActionError, match="missing required key"):
        send_whatsapp({"message": "hi"}, {}, http_client=FakeHttp(), whatsapp=_WA)


def test_send_whatsapp_renders_templated_recipient():
    http = FakeHttp(status_code=200, json_data={"messages": [{"id": "wamid.T"}]})

    send_whatsapp(
        {"to": "{phone}", "message": "hi"},
        {"phone": "+15551234567"},
        http_client=http,
        whatsapp=_WA,
    )

    assert http.calls[0]["json"]["to"] == "+15551234567"


def test_send_whatsapp_recipient_template_missing_field_raises_action_error():
    http = FakeHttp(status_code=200, json_data={"messages": [{"id": "wamid.T"}]})

    with pytest.raises(ActionError, match="rendered empty"):
        send_whatsapp({"to": "{missing}", "message": "hi"}, {}, http_client=http, whatsapp=_WA)

    assert http.calls == []


def test_send_whatsapp_api_error_is_action_error():
    http = FakeHttp(status_code=401, text="invalid token")
    with pytest.raises(ActionError, match="WhatsApp send failed: 401"):
        send_whatsapp({"to": "+1", "message": "hi"}, {}, http_client=http, whatsapp=_WA)


def test_explicit_text_message_type_matches_the_default():
    http = FakeHttp(status_code=200, json_data={"messages": [{"id": "wamid.A"}]})

    send_whatsapp(
        {"to": "+1", "message_type": "text", "message": "hi"},
        {},
        http_client=http,
        whatsapp=_WA,
    )

    assert http.calls[0]["json"]["type"] == "text"


# ── WhatsApp templates (proactive / business-initiated) ──────────────────────


def test_send_whatsapp_template_builds_the_cloud_api_body():
    http = FakeHttp(status_code=200, json_data={"messages": [{"id": "wamid.TPL"}]})

    result = send_whatsapp(
        {
            "to": "+15551234567",
            "message_type": "template",
            "template_name": "demo_booked",
            "language_code": "en_GB",
            "template_params": "{company}, {slot}",
        },
        {"company": "Acme", "slot": "Tuesday 10:00"},
        http_client=http,
        whatsapp=_WA,
    )

    assert result == {"message_id": "wamid.TPL"}
    call = http.calls[0]
    assert call["url"] == "https://graph.facebook.com/v22.0/pn-456/messages"
    assert call["headers"]["Authorization"] == "Bearer tok-123"
    assert call["json"] == {
        "messaging_product": "whatsapp",
        "to": "+15551234567",
        "type": "template",
        "template": {
            "name": "demo_booked",
            "language": {"code": "en_GB"},
            "components": [
                {
                    "type": "body",
                    "parameters": [
                        {"type": "text", "text": "Acme"},
                        {"type": "text", "text": "Tuesday 10:00"},
                    ],
                }
            ],
        },
    }


def test_template_language_defaults_to_en_us():
    http = FakeHttp(status_code=200, json_data={"messages": [{"id": "x"}]})

    send_whatsapp(
        {"to": "+1", "message_type": "template", "template_name": "hello"},
        {},
        http_client=http,
        whatsapp=_WA,
    )

    assert http.calls[0]["json"]["template"]["language"] == {"code": "en_US"}


def test_template_without_params_omits_components():
    http = FakeHttp(status_code=200, json_data={"messages": [{"id": "x"}]})

    send_whatsapp(
        {
            "to": "+1",
            "message_type": "template",
            "template_name": "hello",
            "template_params": "",
        },
        {},
        http_client=http,
        whatsapp=_WA,
    )

    assert "components" not in http.calls[0]["json"]["template"]


def test_template_params_accepts_a_list():
    http = FakeHttp(status_code=200, json_data={"messages": [{"id": "x"}]})

    send_whatsapp(
        {
            "to": "+1",
            "message_type": "template",
            "template_name": "hello",
            "template_params": ["{company}", "static"],
        },
        {"company": "Acme"},
        http_client=http,
        whatsapp=_WA,
    )

    assert http.calls[0]["json"]["template"]["components"][0]["parameters"] == [
        {"type": "text", "text": "Acme"},
        {"type": "text", "text": "static"},
    ]


def test_blank_template_params_are_dropped():
    """A trailing comma must not add an empty positional parameter."""
    http = FakeHttp(status_code=200, json_data={"messages": [{"id": "x"}]})

    send_whatsapp(
        {
            "to": "+1",
            "message_type": "template",
            "template_name": "hello",
            "template_params": "{company},,{missing},",
        },
        {"company": "Acme"},
        http_client=http,
        whatsapp=_WA,
    )

    assert http.calls[0]["json"]["template"]["components"][0]["parameters"] == [
        {"type": "text", "text": "Acme"}
    ]


def test_template_requires_a_template_name():
    with pytest.raises(ActionError, match="missing required key"):
        send_whatsapp(
            {"to": "+1", "message_type": "template"},
            {},
            http_client=FakeHttp(),
            whatsapp=_WA,
        )


def test_unknown_message_type_is_action_error():
    with pytest.raises(ActionError, match="unsupported message_type"):
        send_whatsapp(
            {"to": "+1", "message_type": "image"},
            {},
            http_client=FakeHttp(),
            whatsapp=_WA,
        )


def test_template_send_error_is_action_error():
    http = FakeHttp(status_code=400, text="template not approved")
    with pytest.raises(ActionError, match="WhatsApp send failed: 400"):
        send_whatsapp(
            {"to": "+1", "message_type": "template", "template_name": "nope"},
            {},
            http_client=http,
            whatsapp=_WA,
        )


# ── agent (ADR-0014): requests a run in Core, never executes one ─────────────

_AGENT_CONFIG = {
    "agent_name": "demo-enricher",
    "instructions": "Enrich the inbound demo request.",
    "model": "anthropic/claude-opus-4-8",
    "max_turns": 3,
}


# The reference payload Core emits on `agent.run.completed` (§5) — what a
# chained agent's trigger looks like.
def _completed_event(depth: int, causation_id: str | None = None) -> dict:
    return {
        "run_id": "parent-run",
        "agent": "demo-enricher",
        "status": "completed",
        "causation_id": causation_id,
        "depth": depth,
    }


async def test_agent_action_creates_a_run_in_core():
    core = FakeCore([])

    result = await request_agent_run(
        _AGENT_CONFIG,
        {"demo_request_id": "d1", "company": "Acme"},
        core_client=core.client(),
    )

    assert result == {"run_id": "agent-run-1", "status": "requested", "depth": 0}
    posted = core.agent_run_posts()
    assert len(posted) == 1
    assert core.requests[0][1] == "/api/v1/internal/agent-runs"
    assert posted[0]["agent_name"] == "demo-enricher"
    # §10: the resolved config is captured verbatim, and the triggering payload
    # is the run's input.
    assert posted[0]["definition_snapshot"] == _AGENT_CONFIG
    assert posted[0]["input_payload"] == {"demo_request_id": "d1", "company": "Acme"}


async def test_delivery_travels_in_the_definition_snapshot():
    """ADR-0020: the agent action snapshots its `delivery` sub-config onto the run,
    so the orchestrator can read it back off `agent.run.completed`."""
    core = FakeCore([])
    delivery = {"type": "slack", "config": {"webhook_url": "https://hooks.slack.com/x"}}

    await request_agent_run(
        {**_AGENT_CONFIG, "delivery": delivery},
        {"company": "Acme"},
        core_client=core.client(),
    )

    snapshot = core.agent_run_posts()[0]["definition_snapshot"]
    assert snapshot["delivery"] == delivery


async def test_snapshot_fills_catalog_defaults_for_absent_fields():
    core = FakeCore([])

    await request_agent_run(
        {"agent_name": "a", "instructions": "do the thing"},
        {},
        core_client=core.client(),
    )

    snapshot = core.agent_run_posts()[0]["definition_snapshot"]
    # The catalog default is a deliberately low-cost model (#414) — assert the
    # exact slug so a future silent switch back to an expensive default is caught.
    assert snapshot["model"] == "moonshotai/kimi-k3"
    assert snapshot["max_turns"] == 1


async def test_non_agent_trigger_starts_a_fresh_chain_at_depth_zero():
    core = FakeCore([])

    await request_agent_run(_AGENT_CONFIG, {"demo_request_id": "d1"}, core_client=core.client())

    posted = core.agent_run_posts()[0]
    assert posted["depth"] == 0
    assert posted["causation_id"] is None


async def test_agent_trigger_propagates_causation_and_increments_depth():
    core = FakeCore([])

    result = await request_agent_run(
        _AGENT_CONFIG,
        _completed_event(depth=1, causation_id="chain-root"),
        core_client=core.client(),
    )

    posted = core.agent_run_posts()[0]
    assert posted["depth"] == 2
    assert posted["causation_id"] == "chain-root"
    assert result["depth"] == 2


async def test_root_agent_trigger_becomes_the_chain_id():
    """A depth-0 parent carries no causation_id, so its run id roots the chain."""
    core = FakeCore([])

    await request_agent_run(_AGENT_CONFIG, _completed_event(depth=0), core_client=core.client())

    posted = core.agent_run_posts()[0]
    assert posted["depth"] == 1
    assert posted["causation_id"] == "parent-run"


async def test_payload_with_a_run_id_but_no_depth_is_not_an_agent_chain():
    core = FakeCore([])

    await request_agent_run(_AGENT_CONFIG, {"run_id": "wf-run-9"}, core_client=core.client())

    posted = core.agent_run_posts()[0]
    assert posted["depth"] == 0
    assert posted["causation_id"] is None


async def test_depth_ceiling_refusal_surfaces_as_an_action_error():
    core = FakeCore([], agent_run_status=409, agent_run_detail="exceeds the maximum chain depth")

    with pytest.raises(ActionError, match="Core refused the agent run"):
        await request_agent_run(
            _AGENT_CONFIG, _completed_event(depth=2, causation_id="c"), core_client=core.client()
        )


async def test_agent_action_requires_name_and_instructions():
    core = FakeCore([])

    with pytest.raises(ActionError, match="missing required key"):
        await request_agent_run({"instructions": "x"}, {}, core_client=core.client())
    with pytest.raises(ActionError, match="missing required key"):
        await request_agent_run({"agent_name": "a"}, {}, core_client=core.client())


def test_every_catalog_action_type_has_a_handler():
    """The engine registry and the Core builder catalog must stay in step."""
    assert "agent" in ACTION_HANDLERS


# ── Transient vs permanent classification ────────────────────────────────────
#
# The dispatcher retries `TransientActionError` and nothing else, so this split
# is the whole value of the retry: a retry that also retries permanent failures
# just wastes time and money three times over.


def test_a_throttled_ses_send_is_transient():
    ses = FlakySes(failures=99, code="Throttling")

    with pytest.raises(TransientActionError):
        send_email({"from": "f@x", "to": "t@x"}, {}, ses_client=ses)


def test_a_rejected_ses_recipient_is_permanent():
    ses = FlakySes(failures=99, code="MessageRejected")

    with pytest.raises(ActionError) as caught:
        send_email({"from": "f@x", "to": "t@x"}, {}, ses_client=ses)
    assert not isinstance(caught.value, TransientActionError)


def test_a_missing_config_key_is_permanent():
    with pytest.raises(ActionError) as caught:
        send_email({"from": "f@x"}, {}, ses_client=FakeSes())
    assert not isinstance(caught.value, TransientActionError)


@pytest.mark.parametrize("status", [429, 500, 502, 503])
def test_a_throttled_or_unwell_webhook_is_transient(status: int):
    http = FakeHttp(status_code=status, text="nope")

    with pytest.raises(TransientActionError):
        send_google_chat({"webhook_url": "https://chat.example/x"}, {}, http_client=http)


@pytest.mark.parametrize("status", [400, 401, 403, 404])
def test_a_rejected_webhook_request_is_permanent(status: int):
    # A revoked or mistyped webhook URL is wrong on every attempt.
    http = FakeHttp(status_code=status, text="nope")

    with pytest.raises(ActionError) as caught:
        send_google_chat({"webhook_url": "https://chat.example/x"}, {}, http_client=http)
    assert not isinstance(caught.value, TransientActionError)


def test_a_connection_that_never_completed_is_transient():
    http = FlakyHttp(failures=99, mode="raise")

    with pytest.raises(TransientActionError):
        send_google_chat({"webhook_url": "https://chat.example/x"}, {}, http_client=http)


def test_an_unconfigured_whatsapp_action_is_permanent():
    # No amount of retrying resolves an SSM parameter that was never set.
    with pytest.raises(ActionError) as caught:
        send_whatsapp(
            {"to": "+1", "message": "hi"},
            {},
            http_client=FakeHttp(),
            whatsapp=WhatsAppSettings(access_token="", phone_number_id=""),
        )
    assert not isinstance(caught.value, TransientActionError)


def test_a_5xx_from_the_whatsapp_cloud_api_is_transient():
    http = FakeHttp(status_code=503, text="unavailable")

    with pytest.raises(TransientActionError):
        send_whatsapp({"to": "+1", "message": "hi"}, {}, http_client=http, whatsapp=_WA)


async def test_the_agent_depth_ceiling_refusal_is_permanent():
    """ADR-0014 §8: a 409 is the loop guard tripping. Retrying it would be the
    runaway chain the ceiling exists to stop."""
    core = FakeCore([], agent_run_status=409, agent_run_detail="exceeds the maximum chain depth")

    with pytest.raises(ActionError) as caught:
        await request_agent_run(
            _AGENT_CONFIG, _completed_event(depth=2, causation_id="c"), core_client=core.client()
        )
    assert not isinstance(caught.value, TransientActionError)


@pytest.mark.parametrize("status", [400, 403, 404, 422])
async def test_other_4xx_from_core_on_the_agent_action_is_permanent(status: int):
    core = FakeCore([], agent_run_status=status, agent_run_detail="no")

    with pytest.raises(ActionError) as caught:
        await request_agent_run(_AGENT_CONFIG, {}, core_client=core.client())
    assert not isinstance(caught.value, TransientActionError)


@pytest.mark.parametrize("status", [429, 500, 503])
async def test_a_5xx_or_429_from_core_on_the_agent_action_is_transient(status: int):
    core = FakeCore([], agent_run_status=status, agent_run_detail="unavailable")

    with pytest.raises(TransientActionError):
        await request_agent_run(_AGENT_CONFIG, {}, core_client=core.client())


# ── agent_fan_in: run an agent once N parallel agents have finished (#657) ───
#
# The join. Every sibling's completion fires this action; all but the last
# no-op because the set is not yet complete.

_CHAIN = "chain-root-1"


def _completion(run_id: str = "research-a", *, depth: int = 1) -> dict[str, Any]:
    """The `agent.run.completed` reference payload that triggers a fan-in."""
    return {
        "run_id": run_id,
        "agent": "research-a",
        "status": "completed",
        "causation_id": _CHAIN,
        "depth": depth,
    }


def _summary(run_id: str, agent_name: str, status: str = "completed") -> dict[str, Any]:
    """A chain-listing row, as Core's summary endpoint returns it."""
    return {
        "id": run_id,
        "agent_name": agent_name,
        "status": status,
        "causation_id": _CHAIN,
    }


def _record(output: str) -> dict[str, Any]:
    return {"id": "x", "status": "completed", "result": {"output": output}}


_FAN_IN_CONFIG = {
    "expect_agents": "research-a,research-b",
    "agent_name": "synthesis",
    "instructions": "Reconcile the findings.",
}


def _fan_in_core(chain, records=None, **kwargs):
    return FakeCore(
        [],
        chain_runs=chain,
        agent_run_records=records or {},
        agent_run_id="synthesis-run-1",
        **kwargs,
    )


async def test_fan_in_waits_while_a_sibling_is_still_running():
    """The common case: with N siblings this happens N-1 times."""
    core = _fan_in_core(
        [_summary("ra", "research-a"), _summary("rb", "research-b", status="running")]
    )

    result = await fan_in_agent_runs(_FAN_IN_CONFIG, _completion(), core_client=core.client())

    assert result["status"] == "waiting"
    assert not [p for m, p, _ in core.requests if m == "POST"]


async def test_fan_in_waits_when_an_expected_agent_has_no_run_at_all():
    core = _fan_in_core([_summary("ra", "research-a")])

    result = await fan_in_agent_runs(_FAN_IN_CONFIG, _completion(), core_client=core.client())

    assert result["status"] == "waiting"


async def test_fan_in_fires_once_every_sibling_is_terminal():
    core = _fan_in_core(
        [_summary("ra", "research-a"), _summary("rb", "research-b")],
        {"ra": _record("findings A"), "rb": _record("findings B")},
    )

    result = await fan_in_agent_runs(_FAN_IN_CONFIG, _completion(), core_client=core.client())

    assert result["status"] == "requested"
    assert result["run_id"] == "synthesis-run-1"
    assert result["joined"] == ["research-a", "research-b"]


async def test_the_fired_run_carries_every_siblings_output_keyed_by_agent():
    core = _fan_in_core(
        [_summary("ra", "research-a"), _summary("rb", "research-b")],
        {"ra": _record("findings A"), "rb": _record("findings B")},
    )

    await fan_in_agent_runs(_FAN_IN_CONFIG, _completion(), core_client=core.client())

    posted = [b for m, p, b in core.requests if m == "POST" and p.endswith("/agent-runs")][0]
    assert posted["agent_name"] == "synthesis"
    assert posted["input_payload"]["fan_in"] == {
        "research-a": "findings A",
        "research-b": "findings B",
    }
    # The completion that tripped the join is carried too, so a handler can tell
    # what it was reacting to.
    assert posted["input_payload"]["trigger"]["causation_id"] == _CHAIN


async def test_the_fired_run_stays_in_the_same_chain_and_increments_depth():
    """The §8 loop guard only works if the chain is unbroken."""
    core = _fan_in_core(
        [_summary("ra", "research-a"), _summary("rb", "research-b")],
        {"ra": _record("A"), "rb": _record("B")},
    )

    await fan_in_agent_runs(_FAN_IN_CONFIG, _completion(depth=2), core_client=core.client())

    posted = [b for m, p, b in core.requests if m == "POST" and p.endswith("/agent-runs")][0]
    assert posted["causation_id"] == _CHAIN
    assert posted["depth"] == 3


async def test_expect_agents_is_not_sent_as_part_of_the_run_snapshot():
    """It configures the join, not the agent — a run's snapshot is what explains
    the run afterwards (§10) and this would be noise in it."""
    core = _fan_in_core(
        [_summary("ra", "research-a"), _summary("rb", "research-b")],
        {"ra": _record("A"), "rb": _record("B")},
    )

    await fan_in_agent_runs(_FAN_IN_CONFIG, _completion(), core_client=core.client())

    posted = [b for m, p, b in core.requests if m == "POST" and p.endswith("/agent-runs")][0]
    assert "expect_agents" not in posted["definition_snapshot"]
    assert posted["definition_snapshot"]["instructions"] == "Reconcile the findings."


async def test_a_failed_sibling_is_terminal_and_the_join_proceeds_without_it():
    """Redundant angles want a degraded answer, not a hang."""
    core = _fan_in_core(
        [_summary("ra", "research-a"), _summary("rb", "research-b", status="failed")],
        {"ra": _record("findings A")},
    )

    result = await fan_in_agent_runs(_FAN_IN_CONFIG, _completion(), core_client=core.client())

    assert result["status"] == "requested"
    assert result["joined"] == ["research-a"]
    posted = [b for m, p, b in core.requests if m == "POST" and p.endswith("/agent-runs")][0]
    assert posted["input_payload"]["fan_in"] == {"research-a": "findings A"}


async def test_every_sibling_failing_fails_the_action_rather_than_running_on_nothing():
    core = _fan_in_core(
        [
            _summary("ra", "research-a", status="failed"),
            _summary("rb", "research-b", status="failed"),
        ]
    )

    with pytest.raises(ActionError, match="nothing to run"):
        await fan_in_agent_runs(_FAN_IN_CONFIG, _completion(), core_client=core.client())


async def test_the_join_does_not_fire_twice_for_the_same_chain():
    """The idempotency guard: a synthesis run already in the chain means an
    earlier completion won the race. Each duplicate is a real invoice."""
    core = _fan_in_core(
        [
            _summary("ra", "research-a"),
            _summary("rb", "research-b"),
            _summary("s1", "synthesis"),
        ],
        {"ra": _record("A"), "rb": _record("B")},
    )

    result = await fan_in_agent_runs(_FAN_IN_CONFIG, _completion(), core_client=core.client())

    assert result["status"] == "already_fired"
    assert result["run_id"] == "s1"
    assert not [p for m, p, _ in core.requests if m == "POST" and p.endswith("/agent-runs")]


async def test_runs_from_another_chain_are_not_counted():
    """Two scouts running at once must not satisfy each other's joins."""
    other = dict(_summary("rb", "research-b"), causation_id="a-different-chain")
    core = _fan_in_core([_summary("ra", "research-a"), other])

    result = await fan_in_agent_runs(_FAN_IN_CONFIG, _completion(), core_client=core.client())

    assert result["status"] == "waiting"


async def test_an_unchained_trigger_is_a_configuration_error():
    """Triggered by something that is not an agent completion — there is no
    chain to join, and silently doing nothing would hide the misconfiguration."""
    core = _fan_in_core([])

    with pytest.raises(ActionError, match="chained trigger"):
        await fan_in_agent_runs(_FAN_IN_CONFIG, {"id": "not-a-run"}, core_client=core.client())


async def test_expect_agents_accepts_a_list_as_well_as_a_string():
    core = _fan_in_core(
        [_summary("ra", "research-a"), _summary("rb", "research-b")],
        {"ra": _record("A"), "rb": _record("B")},
    )
    config = {**_FAN_IN_CONFIG, "expect_agents": ["research-a", "research-b"]}

    result = await fan_in_agent_runs(config, _completion(), core_client=core.client())

    assert result["status"] == "requested"


async def test_an_empty_expect_agents_is_rejected():
    core = _fan_in_core([])

    with pytest.raises(ActionError, match="nothing to wait for"):
        await fan_in_agent_runs(
            {**_FAN_IN_CONFIG, "expect_agents": " , "}, _completion(), core_client=core.client()
        )


async def test_missing_required_config_is_a_permanent_failure():
    core = _fan_in_core([])

    with pytest.raises(ActionError, match="expect_agents"):
        await fan_in_agent_runs(
            {"agent_name": "synthesis", "instructions": "x"},
            _completion(),
            core_client=core.client(),
        )


async def test_a_depth_ceiling_refusal_is_permanent_not_retried():
    """409 is §8 stopping a runaway chain — retrying is the runaway."""
    core = _fan_in_core(
        [_summary("ra", "research-a"), _summary("rb", "research-b")],
        {"ra": _record("A"), "rb": _record("B")},
        agent_run_status=409,
    )

    with pytest.raises(ActionError) as exc:
        await fan_in_agent_runs(_FAN_IN_CONFIG, _completion(), core_client=core.client())
    assert not isinstance(exc.value, TransientActionError)


async def test_core_being_briefly_unwell_is_retried():
    core = _fan_in_core(
        [_summary("ra", "research-a"), _summary("rb", "research-b")],
        {"ra": _record("A"), "rb": _record("B")},
        agent_run_status=503,
    )

    with pytest.raises(TransientActionError):
        await fan_in_agent_runs(_FAN_IN_CONFIG, _completion(), core_client=core.client())


async def test_the_action_is_registered_under_its_catalog_type():
    assert ACTION_HANDLERS["agent_fan_in"] is fan_in_agent_runs


def _record_with_input(output: str, input_payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": "x",
        "status": "completed",
        "result": {"output": output},
        "input_payload": input_payload,
    }


async def test_the_join_forwards_what_every_sibling_was_briefed_with():
    """The fan-in agent reasons over its siblings' outputs; until now that was
    all it got.

    What those outputs are *about* — who the work is for, what was asked — lives
    in the siblings' `input_payload`, which this action already fetched in full
    and then threw away. An Idea Scout synthesis agent asked to weigh a founder's
    profile was never given one, and said so in its own output
    (biffo-plugin-idea-scout#26).
    """
    brief = {"build_type": {"key": "micro-saas"}, "complexity": "moderate"}
    core = _fan_in_core(
        [_summary("ra", "research-a"), _summary("rb", "research-b")],
        {
            "ra": _record_with_input("findings A", {**brief, "angle": "community"}),
            "rb": _record_with_input("findings B", {**brief, "angle": "competitive"}),
        },
    )

    await fan_in_agent_runs(_FAN_IN_CONFIG, _completion(), core_client=core.client())

    posted = [b for m, p, b in core.requests if m == "POST" and p.endswith("/agent-runs")][0]
    assert posted["input_payload"]["context"] == brief
    # `angle` differs per sibling, so it is that sibling's own input and not
    # context about the fan-out. Forwarding it would tell the joining agent that
    # the whole run was about one angle.
    assert "angle" not in posted["input_payload"]["context"]


async def test_the_joined_outputs_keep_their_existing_shape():
    """`context` is additive. Anything already reading `fan_in` is untouched."""
    core = _fan_in_core(
        [_summary("ra", "research-a"), _summary("rb", "research-b")],
        {
            "ra": _record_with_input("findings A", {"brief": 1}),
            "rb": _record_with_input("findings B", {"brief": 1}),
        },
    )

    await fan_in_agent_runs(_FAN_IN_CONFIG, _completion(), core_client=core.client())

    posted = [b for m, p, b in core.requests if m == "POST" and p.endswith("/agent-runs")][0]
    assert posted["input_payload"]["fan_in"] == {
        "research-a": "findings A",
        "research-b": "findings B",
    }


async def test_no_context_key_when_the_siblings_share_nothing():
    """An empty object would read as "briefed with nothing", which is a
    different claim from "we cannot tell". Omit the key instead."""
    core = _fan_in_core(
        [_summary("ra", "research-a"), _summary("rb", "research-b")],
        {
            "ra": _record_with_input("findings A", {"only": "a"}),
            "rb": _record_with_input("findings B", {"only": "b"}),
        },
    )

    await fan_in_agent_runs(_FAN_IN_CONFIG, _completion(), core_client=core.client())

    posted = [b for m, p, b in core.requests if m == "POST" and p.endswith("/agent-runs")][0]
    assert "context" not in posted["input_payload"]


async def test_a_failed_sibling_does_not_narrow_the_context():
    """Only completed siblings are read, so a failed one cannot drag the shared
    set down to nothing — and is not fetched, which would be one more way for
    the join to fail transiently on a run it does not need."""
    core = _fan_in_core(
        [_summary("ra", "research-a"), _summary("rb", "research-b", status="failed")],
        {"ra": _record_with_input("findings A", {"brief": "shared"})},
    )

    result = await fan_in_agent_runs(_FAN_IN_CONFIG, _completion(), core_client=core.client())

    assert result["status"] == "requested"
    posted = [b for m, p, b in core.requests if m == "POST" and p.endswith("/agent-runs")][0]
    assert posted["input_payload"]["context"] == {"brief": "shared"}
