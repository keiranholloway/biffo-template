"""Tests for the email action handler."""

from __future__ import annotations

import pytest

from orchestrator.actions import ActionError, send_email
from orchestrator_fakes import FakeSes


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
