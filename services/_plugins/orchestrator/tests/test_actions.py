"""Tests for the action handlers (email, Google Chat, WhatsApp, agent)."""

from __future__ import annotations

import pytest
from orchestrator.actions import (
    ACTION_HANDLERS,
    ActionError,
    WhatsAppSettings,
    request_agent_run,
    send_email,
    send_google_chat,
    send_whatsapp,
)
from orchestrator_fakes import FakeCore, FakeHttp, FakeSes


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


async def test_snapshot_fills_catalog_defaults_for_absent_fields():
    core = FakeCore([])

    await request_agent_run(
        {"agent_name": "a", "instructions": "do the thing"},
        {},
        core_client=core.client(),
    )

    snapshot = core.agent_run_posts()[0]["definition_snapshot"]
    assert snapshot["model"] == "anthropic/claude-opus-4-8"
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
