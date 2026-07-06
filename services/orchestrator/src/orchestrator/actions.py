"""Action handlers the engine dispatches (thin wedge: email via SES).

An action handler takes a definition's ``action_config`` and the triggering
event payload, performs a side effect, and returns a small JSON-serialisable
result recorded to the Core audit log. New channels (SMS, voice, agentic) are
added by registering another handler in ``ACTION_HANDLERS`` — the engine looks
up the handler by the definition's ``action_type``.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Protocol


class SesClient(Protocol):
    """The slice of the boto3 SES client the email action uses."""

    def send_email(self, **kwargs: Any) -> dict[str, Any]: ...


class ActionError(Exception):
    """A dispatch failure the engine records as a failed run (not a crash)."""


def _render(template: str, payload: dict[str, Any]) -> str:
    """Fill ``{field}`` placeholders from the event payload.

    Missing fields render as an empty string rather than raising, so a
    template referencing a field a given event happens not to carry still
    produces a sendable message.
    """
    return template.format_map(defaultdict(str, payload))


def send_email(
    config: dict[str, Any], payload: dict[str, Any], *, ses_client: SesClient
) -> dict[str, Any]:
    """Send a templated email via SES.

    ``config`` keys: ``from`` (verified SES sender, required), ``to`` (address
    or list, required), ``subject`` and ``body`` (optional ``{field}`` templates
    filled from the event payload).
    """
    try:
        source = config["from"]
        to = config["to"]
    except KeyError as exc:
        raise ActionError(f"email action_config missing required key: {exc}") from exc

    recipients = [to] if isinstance(to, str) else list(to)
    subject = _render(config.get("subject", "Notification"), payload)
    body = _render(config.get("body", ""), payload)

    response = ses_client.send_email(
        Source=source,
        Destination={"ToAddresses": recipients},
        Message={
            "Subject": {"Data": subject},
            "Body": {"Text": {"Data": body}},
        },
    )
    return {"message_id": response.get("MessageId")}


# action_type -> handler. The engine dispatches by this key (ADR-0003 plugin).
ACTION_HANDLERS: dict[str, Any] = {
    "email": send_email,
}
