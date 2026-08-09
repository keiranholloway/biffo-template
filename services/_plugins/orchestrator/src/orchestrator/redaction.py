"""Redact credential-shaped fields from an event payload before it is logged.

``main.handler`` logs the full inbound EventBridge event at INFO level on
every invocation — by design, for debuggability: it is the verification
mechanism tabsii's e-signature/FDD/Discovery-Day features already rely on via
the `signing_url`/`disclosure_url` pattern, while SES can't yet deliver real
email in some environments. That is a reasonable trade for a scoped,
single-use bearer token. It is not a reasonable trade for a payload carrying
a real Cognito temporary password (biffo-template#950, the second half of
#1182 — the first half added ``CognitoAdmin.create_user``'s
``temporary_password`` parameter): a live login credential is a materially
different risk, and nothing about the log line's purpose requires the
credential's actual value to be legible.

This module gives ``main.handler`` a redact-before-log step that never
touches the real event: the real, unredacted payload still reaches
``create_event_handler``/``plugin.events.dispatch`` (and therefore any action
handler, e.g. "Send email", that legitimately needs the credential) — only
the copy handed to the logger is masked.
"""

from __future__ import annotations

from typing import Any

#: What a redacted credential-shaped value is replaced with in a log line.
REDACTED = "***"

# Deliberately mirrors ``services/api/src/api/routing/crud_handlers.py``'s
# ``_SENSITIVE_SUBSTRINGS`` — the Core API's own credential-shaped-column
# detector (also reused by ``services/api/src/api/events/event_fields.py`` to
# keep a credential-shaped column out of the workflow-builder's condition
# catalog). The orchestrator plugin cannot import that constant directly: it
# has no dependency on the ``biffo-api`` package, only on ``biffo-plugin-sdk``
# (ADR-0002 — a plugin calls the Core API over HTTP, never its Python
# internals), so `biffo-plugin-orchestrator`'s own `pyproject.toml` has
# nothing to import it through. This is a deliberate, documented duplicate of
# one list rather than a second, independently-invented one (the
# `_extract_detail` class of defect, biffo-template#1108) — keep the two in
# sync by hand, and if they need to converge structurally that is a
# `packages/python-sdk` change, not something to solve unilaterally here.
_CREDENTIAL_KEY_SUBSTRINGS = (
    "password",
    "secret",
    "token",
    "api_key",
    "apikey",
    "private_key",
    "credential",
    "ssn",
)


def _is_credential_shaped_key(key: str) -> bool:
    lowered = key.lower()
    return any(substring in lowered for substring in _CREDENTIAL_KEY_SUBSTRINGS)


def redact_event_payload(value: Any) -> Any:
    """Return a copy of ``value`` with credential-shaped dict values masked.

    Walks dicts and lists recursively, so a credential nested under
    EventBridge's own envelope (``event["detail"]["payload"]["temporary_password"]``)
    is caught, not only a top-level key. Matching is by KEY NAME substring
    (case-insensitive, see ``_CREDENTIAL_KEY_SUBSTRINGS``) rather than by
    value shape — there is no reliable way to recognise a credential from
    its value alone (a temporary password can look like any other short
    string), but the field name a payload's author chose to carry one is a
    stable, deliberate signal, the same premise ``crud_handlers``'s own
    by-name detector already relies on.

    A matched key's entire value is replaced with :data:`REDACTED` rather
    than redacted-in-place — unlike ``cognito.redact_secret`` (which strips a
    *known* secret out of free text while leaving the rest of the message
    legible), here the secret's own value is never known in advance, so
    there is nothing to substring-match against; the field is credential-
    shaped by name alone, and masking the whole value is the only sound
    option.

    Never mutates its input, and never raises: this exists to protect a log
    line, and a bug in redaction must not be able to break the event dispatch
    that follows it in ``main.handler``. Anything this cannot classify — an
    unexpected exception walking a malformed structure — degrades to a single
    :data:`REDACTED` sentinel rather than propagating, which fails toward
    "logged nothing legible" rather than "logged the unredacted payload
    anyway".
    """
    try:
        if isinstance(value, dict):
            return {
                key: (
                    REDACTED if _is_credential_shaped_key(str(key)) else redact_event_payload(val)
                )
                for key, val in value.items()
            }
        if isinstance(value, list):
            return [redact_event_payload(item) for item in value]
        return value
    except Exception:  # noqa: BLE001 — a redaction bug must fail closed, not raise
        return REDACTED
