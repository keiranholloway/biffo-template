"""Action handlers the engine dispatches.

An action handler takes a definition's ``action_config`` and the triggering
event payload, performs a side effect, and returns a small JSON-serialisable
result recorded to the Core audit log. New channels are added by registering
another handler in ``ACTION_HANDLERS`` — the engine looks up the handler by the
definition's ``action_type`` (and must add a matching entry to the Core builder
catalog, ``schemas/orchestration.WORKFLOW_ACTIONS``, so it can be configured).

The dispatcher passes every handler the same keyword clients (``ses_client``,
``http_client``, ``whatsapp``); each handler keeps the ones it needs and ignores
the rest via ``**_``. That keeps adding a channel to a single new function here
without touching the dispatch signature.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Protocol


class SesClient(Protocol):
    """The slice of the boto3 SES client the email action uses."""

    def send_email(self, **kwargs: Any) -> dict[str, Any]: ...


class HttpResponse(Protocol):
    """The slice of an HTTP response the webhook actions read."""

    status_code: int
    text: str

    def json(self) -> Any: ...


class HttpClient(Protocol):
    """The slice of an HTTP client the webhook actions use (e.g. httpx.Client)."""

    def post(
        self,
        url: str,
        *,
        json: Any = None,
        headers: dict[str, str] | None = None,
    ) -> HttpResponse: ...


@dataclass(frozen=True)
class WhatsAppSettings:
    """Account-level WhatsApp Cloud API credentials, injected from the
    orchestrator's environment — never from a workflow's ``action_config`` (a
    definition is stored in the DB, so it must not carry the access token)."""

    access_token: str
    phone_number_id: str
    api_version: str = "v22.0"

    @property
    def configured(self) -> bool:
        return bool(self.access_token and self.phone_number_id)


class ActionError(Exception):
    """A dispatch failure the engine records as a failed run (not a crash)."""


def _render(template: str, payload: dict[str, Any]) -> str:
    """Fill ``{field}`` placeholders from the event payload.

    Missing fields render as an empty string rather than raising, so a
    template referencing a field a given event happens not to carry still
    produces a sendable message.
    """
    return template.format_map(defaultdict(str, payload))


def _require(config: dict[str, Any], action: str, key: str) -> Any:
    try:
        return config[key]
    except KeyError as exc:
        raise ActionError(
            f"{action} action_config missing required key: {exc}"
        ) from exc


def send_email(
    config: dict[str, Any], payload: dict[str, Any], *, ses_client: SesClient, **_: Any
) -> dict[str, Any]:
    """Send a templated email via SES.

    ``config`` keys: ``from`` (verified SES sender, required), ``to`` (address
    or list, required), ``subject`` and ``body`` (optional ``{field}`` templates
    filled from the event payload).
    """
    source = _require(config, "email", "from")
    to = _require(config, "email", "to")

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


def send_google_chat(
    config: dict[str, Any],
    payload: dict[str, Any],
    *,
    http_client: HttpClient,
    **_: Any,
) -> dict[str, Any]:
    """Post a message to a Google Chat space via an incoming webhook.

    ``config`` keys: ``webhook_url`` (the space's incoming-webhook URL, which
    embeds its own auth token — required) and ``message`` (a ``{field}`` template
    filled from the event payload). Posts ``{"text": ...}``; a non-2xx response
    is recorded as a failed run.
    """
    url = _require(config, "google_chat", "webhook_url")
    text = _render(config.get("message", ""), payload)

    response = http_client.post(url, json={"text": text})
    if response.status_code >= 400:
        raise ActionError(
            f"Google Chat webhook failed: {response.status_code} {response.text}"
        )
    return {"status_code": response.status_code}


def _template_params(config: dict[str, Any], payload: dict[str, Any]) -> list[str]:
    """The ordered body parameters of a template message, rendered.

    Accepts either a list (from an API caller) or a comma-separated string (what
    the portal's single-line input produces). Each entry is a ``{field}``
    template filled from the event payload; blank entries are dropped, because a
    trailing comma should not add an empty positional parameter Meta would
    reject.
    """
    raw = config.get("template_params") or []
    items = raw.split(",") if isinstance(raw, str) else list(raw)
    rendered = [_render(str(item).strip(), payload) for item in items]
    return [value for value in rendered if value]


def _whatsapp_body(
    config: dict[str, Any], payload: dict[str, Any], to: str
) -> dict[str, Any]:
    """Build the Cloud API message body for the configured ``message_type``."""
    message_type = config.get("message_type") or "text"

    if message_type == "text":
        return {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "text",
            "text": {"body": _render(config.get("message", ""), payload)},
        }

    if message_type == "template":
        name = _require(config, "whatsapp", "template_name")
        language = config.get("language_code") or "en_US"
        template: dict[str, Any] = {
            "name": name,
            "language": {"code": language},
        }
        # Omit `components` entirely for a template with no body variables —
        # Meta rejects an empty parameter list.
        parameters = _template_params(config, payload)
        if parameters:
            template["components"] = [
                {
                    "type": "body",
                    "parameters": [
                        {"type": "text", "text": value} for value in parameters
                    ],
                }
            ]
        return {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "template",
            "template": template,
        }

    raise ActionError(
        f"whatsapp action_config has unsupported message_type: {message_type!r} "
        "(expected 'text' or 'template')"
    )


def send_whatsapp(
    config: dict[str, Any],
    payload: dict[str, Any],
    *,
    http_client: HttpClient,
    whatsapp: WhatsAppSettings | None,
    **_: Any,
) -> dict[str, Any]:
    """Send a WhatsApp message via the Meta Cloud API.

    Account credentials (access token + phone-number id) are injected from the
    orchestrator environment, so ``config`` never carries them. Per-workflow
    keys: ``to`` (recipient in international format, required) and
    ``message_type`` — ``"text"`` (default) or ``"template"``.

    - ``text``: ``message`` is a ``{field}`` template filled from the payload.
      A text message only delivers inside an **open 24-hour customer service
      window**, so it suits replies, not proactive notifications.
    - ``template``: ``template_name`` (required) plus ``language_code``
      (default ``en_US``) and ``template_params`` — the ordered body variables,
      each a ``{field}`` template. This is the only shape Meta accepts for a
      proactive, business-initiated message, and the template must already be
      **approved in WhatsApp Manager**; this action cannot create one.
    """
    if whatsapp is None or not whatsapp.configured:
        raise ActionError(
            "WhatsApp is not configured — set WHATSAPP_ACCESS_TOKEN and "
            "WHATSAPP_PHONE_NUMBER_ID on the orchestrator."
        )
    to = _require(config, "whatsapp", "to")
    body = _whatsapp_body(config, payload, to)

    url = (
        f"https://graph.facebook.com/{whatsapp.api_version}"
        f"/{whatsapp.phone_number_id}/messages"
    )
    response = http_client.post(
        url,
        json=body,
        headers={"Authorization": f"Bearer {whatsapp.access_token}"},
    )
    if response.status_code >= 400:
        raise ActionError(
            f"WhatsApp send failed: {response.status_code} {response.text}"
        )
    data = response.json()
    messages = data.get("messages") if isinstance(data, dict) else None
    message_id = messages[0].get("id") if messages else None
    return {"message_id": message_id}


# action_type -> handler. The engine dispatches by this key (ADR-0003 plugin).
# Keep in step with the Core builder catalog (WORKFLOW_ACTIONS) so every
# offered action has a handler and vice versa.
ACTION_HANDLERS: dict[str, Any] = {
    "email": send_email,
    "google_chat": send_google_chat,
    "whatsapp": send_whatsapp,
}
