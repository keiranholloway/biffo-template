"""Redaction is the runtime's job, not the prompt author's (ADR-0014 Security model)."""

from __future__ import annotations

from agent_runtime.redaction import EMAIL_PLACEHOLDER, redact_emails


def test_redacts_a_bare_address():
    assert redact_emails("lead@acme.com") == EMAIL_PLACEHOLDER


def test_redacts_addresses_embedded_in_prose():
    result = redact_emails("Contact jane.doe+demo@acme.co.uk or ops@acme.co.uk today")
    assert "acme.co.uk" not in result
    assert result.count(EMAIL_PLACEHOLDER) == 2


def test_redacts_nested_structures_including_keys():
    payload = {
        "contact": {"email": "lead@acme.com", "name": "Jane"},
        "notes": ["cc sales@acme.com", 42, None],
        "ops@acme.com": "the key is attacker-supplied too",
    }

    result = redact_emails(payload)

    assert result["contact"] == {"email": EMAIL_PLACEHOLDER, "name": "Jane"}
    assert result["notes"] == [f"cc {EMAIL_PLACEHOLDER}", 42, None]
    assert EMAIL_PLACEHOLDER in result
    assert "acme.com" not in repr(result)


def test_redacts_an_address_hidden_in_an_unrelated_field():
    # The form is public: an attacker choosing to put the address in `company`
    # rather than `email` must not defeat a key-based redactor. This is why the
    # walk is structural.
    payload = {"company": "Acme (reach me at ceo@acme.com)"}

    assert redact_emails(payload) == {"company": f"Acme (reach me at {EMAIL_PLACEHOLDER})"}


def test_leaves_non_string_scalars_alone():
    assert redact_emails({"n": 1, "ok": True, "f": 1.5, "none": None}) == {
        "n": 1,
        "ok": True,
        "f": 1.5,
        "none": None,
    }
