"""Tests for orchestrator.redaction — the by-key-name payload masker used
before ``main.handler`` logs an inbound event (biffo-template#950, the
second half of #1182)."""

from __future__ import annotations

from orchestrator.redaction import REDACTED, redact_event_payload


def test_redacts_a_top_level_credential_shaped_key():
    out = redact_event_payload({"temporary_password": "correct-horse-battery-staple"})

    assert out == {"temporary_password": REDACTED}


def test_leaves_non_credential_keys_untouched():
    out = redact_event_payload({"email": "a@b.com", "demo_request_id": "d1"})

    assert out == {"email": "a@b.com", "demo_request_id": "d1"}


def test_redacts_nested_under_the_eventbridge_envelope():
    """The real shape the handler receives: source/detail-type/detail, with
    the credential inside detail.payload."""
    event = {
        "source": "biffo.core",
        "detail-type": "user.invited",
        "detail": {
            "schema_version": "1.0",
            "tenant_id": "default",
            "payload": {"temporary_password": "hunter2hunter2", "email": "a@b.com"},
        },
    }

    out = redact_event_payload(event)

    assert out["detail"]["payload"] == {"temporary_password": REDACTED, "email": "a@b.com"}
    # Everything outside the credential is unchanged.
    assert out["source"] == "biffo.core"
    assert out["detail-type"] == "user.invited"
    assert out["detail"]["schema_version"] == "1.0"


def test_redacts_inside_a_list_of_dicts():
    out = redact_event_payload({"resources": [{"password": "p1"}, {"password": "p2"}]})

    assert out == {"resources": [{"password": REDACTED}, {"password": REDACTED}]}


def test_matching_is_case_insensitive_and_by_substring():
    out = redact_event_payload({"TemporaryPassword": "x", "user_secret_key": "y"})

    assert out == {"TemporaryPassword": REDACTED, "user_secret_key": REDACTED}


def test_covers_every_credential_shaped_substring_the_issue_named():
    """The tabsii PR's own list (#950's context): password/temp_password/
    temporary_password-shaped keys — plus the wider set this module shares
    with crud_handlers._SENSITIVE_SUBSTRINGS so it doesn't regress to a
    narrower list than the Core API's own detector."""
    payload = {
        "password": "a",
        "temp_password": "b",
        "temporary_password": "c",
        "secret": "d",
        "token": "e",
        "api_key": "f",
        "apikey": "g",
        "private_key": "h",
        "credential": "i",
        "ssn": "j",
    }

    out = redact_event_payload(payload)

    assert all(value == REDACTED for value in out.values())


def test_does_not_mutate_the_input():
    """main.handler still passes the REAL event to create_event_handler /
    plugin.events.dispatch after logging — redaction must never touch the
    caller's dict in place."""
    original = {"temporary_password": "real-password", "nested": {"password": "real2"}}
    snapshot = {"temporary_password": "real-password", "nested": {"password": "real2"}}

    redact_event_payload(original)

    assert original == snapshot


def test_scalars_and_none_pass_through_unchanged():
    assert redact_event_payload("plain string") == "plain string"
    assert redact_event_payload(42) == 42
    assert redact_event_payload(None) is None


def test_redaction_failure_fails_closed_not_open():
    """A key that cannot be coerced to str (e.g. an unhashable/odd object as
    a dict key is not representable in a plain dict, so simulate the failure
    mode directly) must degrade to REDACTED rather than let the exception
    propagate into the caller's log statement — a broken redaction must never
    become "logged the payload unredacted"."""

    class _ExplodesOnStr:
        def __str__(self):
            raise RuntimeError("boom")

    out = redact_event_payload({_ExplodesOnStr(): "value"})

    assert out == REDACTED
