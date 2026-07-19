"""Tests for the action handlers (email, Google Chat, WhatsApp)."""

from __future__ import annotations

import pytest

from orchestrator.actions import (
    ActionError,
    WhatsAppSettings,
    send_email,
    send_google_chat,
    send_whatsapp,
)
from orchestrator_fakes import FakeHttp, FakeSes


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

    send_email(
        {"from": "f@x", "to": "t@x", "subject": "Hi {missing}"}, {}, ses_client=ses
    )

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
