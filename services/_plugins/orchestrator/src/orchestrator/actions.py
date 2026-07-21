"""Action handlers the engine dispatches.

An action handler takes a definition's ``action_config`` and the triggering
event payload, performs a side effect, and returns a small JSON-serialisable
result recorded to the Core audit log. New channels are added by registering
another handler in ``ACTION_HANDLERS`` — the engine looks up the handler by the
definition's ``action_type`` (and must add a matching entry to the Core builder
catalog, ``schemas/orchestration.WORKFLOW_ACTIONS``, so it can be configured).

The dispatcher passes every handler the same keyword clients (``ses_client``,
``http_client``, ``core_client``, ``whatsapp``); each handler keeps the ones it
needs and ignores the rest via ``**_``. That keeps adding a channel to a single
new function here without touching the dispatch signature.

A handler may be ``async def`` when its side effect is an ``await``-only call —
the Core API client is async, so the ``agent`` action is. The dispatcher awaits
whatever a handler returns if it is awaitable, so sync and async handlers are
registered identically.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Protocol

from biffo_plugin_sdk import BiffoAPIError


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


class CoreClient(Protocol):
    """The slice of the IAM-signed Core API client the agent action uses.

    Satisfied by ``SignedCoreClient`` from the plugin SDK — the same client the
    plugin already uses to claim runs and post results (ADR-0009). The agent
    action never builds its own.
    """

    async def post(self, path: str, json: dict[str, Any] | None = None) -> Any: ...


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
    """A dispatch failure the engine records as a failed run (not a crash).

    Permanent by default: a bad recipient, a missing config key or a rejected
    request will fail identically however many times it is sent.
    """


class TransientActionError(ActionError):
    """A failure that might not recur — the dispatcher retries these.

    Throttling, a 5xx from the far end, or a connection that never completed.
    Retrying a permanent failure just burns the Lambda's budget three times
    over, so handlers must raise this only when a later attempt could
    plausibly succeed.
    """


# AWS error codes that mean "try again", not "this will never work".
_TRANSIENT_AWS_CODES = frozenset(
    {
        "InternalError",
        "InternalFailure",
        "RequestTimeout",
        "ServiceUnavailable",
        "SlowDown",
        "Throttling",
        "ThrottlingException",
        "TooManyRequestsException",
    }
)


def _transient_status(status_code: int) -> bool:
    """Whether an HTTP status is worth another attempt.

    429 (throttled) and 5xx (the far end is unwell) are; every other 4xx means
    the request itself is wrong and will be wrong next time too.
    """
    return status_code == 429 or status_code >= 500


def _aws_failure(action: str, exc: Exception) -> ActionError:
    """Classify a boto exception as transient or permanent.

    Reads ``exc.response["Error"]["Code"]`` by duck-typing rather than importing
    botocore, so the fakes in the tests classify the same way the real client
    does.
    """
    code = ""
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        error = response.get("Error")
        if isinstance(error, dict):
            code = str(error.get("Code", ""))
    detail = code or str(exc)
    if code in _TRANSIENT_AWS_CODES or isinstance(exc, (TimeoutError, ConnectionError)):
        return TransientActionError(f"{action} failed (transient): {detail}")
    return ActionError(f"{action} failed: {detail}")


def _http_failure(action: str, response: HttpResponse) -> ActionError:
    """A non-2xx webhook response, classified for retry."""
    message = f"{action} failed: {response.status_code} {response.text}"
    if _transient_status(response.status_code):
        return TransientActionError(message)
    return ActionError(message)


def _post(
    http_client: HttpClient,
    action: str,
    url: str,
    *,
    json: Any = None,
    headers: dict[str, str] | None = None,
) -> HttpResponse:
    """POST, treating any transport-level failure as transient.

    A request that never got an answer — DNS, connect timeout, read timeout,
    reset connection — is the failure mode worth retrying, and it is what an
    exception out of the client almost always means here.
    """
    try:
        return http_client.post(url, json=json, headers=headers)
    except Exception as exc:  # noqa: BLE001 — no answer from the far end is transient
        raise TransientActionError(f"{action} request failed: {exc}") from exc


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
        raise ActionError(f"{action} action_config missing required key: {exc}") from exc


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

    try:
        response = ses_client.send_email(
            Source=source,
            Destination={"ToAddresses": recipients},
            Message={
                "Subject": {"Data": subject},
                "Body": {"Text": {"Data": body}},
            },
        )
    except Exception as exc:  # noqa: BLE001 — classified, then recorded or retried
        raise _aws_failure("SES send", exc) from exc
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

    response = _post(http_client, "Google Chat webhook", url, json={"text": text})
    if response.status_code >= 400:
        raise _http_failure("Google Chat webhook", response)
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


def _whatsapp_body(config: dict[str, Any], payload: dict[str, Any], to: str) -> dict[str, Any]:
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
                    "parameters": [{"type": "text", "text": value} for value in parameters],
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
            "WhatsApp is not configured — point WHATSAPP_ACCESS_TOKEN_PARAMETER "
            "and WHATSAPP_PHONE_NUMBER_ID_PARAMETER at SSM parameters holding "
            "the credentials, and check the engine can read them."
        )
    to = _require(config, "whatsapp", "to")
    body = _whatsapp_body(config, payload, to)

    url = f"https://graph.facebook.com/{whatsapp.api_version}/{whatsapp.phone_number_id}/messages"
    response = _post(
        http_client,
        "WhatsApp send",
        url,
        json=body,
        headers={"Authorization": f"Bearer {whatsapp.access_token}"},
    )
    if response.status_code >= 400:
        raise _http_failure("WhatsApp send", response)
    data = response.json()
    messages = data.get("messages") if isinstance(data, dict) else None
    message_id = messages[0].get("id") if messages else None
    return {"message_id": message_id}


_AGENT_RUNS_PATH = "/api/v1/internal/agent-runs"

# Catalog defaults for the agent action, applied to the snapshot when a stored
# definition predates a field or leaves it blank. Mirrors the ``default`` values
# in the Core builder catalog (schemas/orchestration.WORKFLOW_ACTIONS) — a run
# must record what it actually executed, not what the config happened to spell
# out (ADR-0014 §10).
AGENT_CONFIG_DEFAULTS: dict[str, Any] = {
    "model": "anthropic/claude-opus-4-8",
    "max_turns": 1,
}


def _agent_chain(payload: dict[str, Any]) -> tuple[str | None, int]:
    """The ``(causation_id, depth)`` this run inherits from its trigger (§8).

    An agent triggered by another agent's ``agent.run.completed`` sees that
    event's reference payload — ``{run_id, agent, status, causation_id, depth}``
    — so the chain is read straight off it: keep the parent's ``causation_id``
    (falling back to the parent's ``run_id`` when the parent is itself the root)
    and increment ``depth``. Anything else is a fresh chain at depth 0.

    This is the whole of the loop guard's input. Core refuses past the ceiling
    on ``depth`` alone, so a run that reports 0 forever makes the ceiling
    unreachable — hence deriving it here rather than defaulting it.
    """
    depth = payload.get("depth")
    run_id = payload.get("run_id")
    if not isinstance(depth, int) or isinstance(depth, bool) or not run_id:
        return None, 0
    causation_id = payload.get("causation_id") or run_id
    return str(causation_id), max(depth, 0) + 1


async def request_agent_run(
    config: dict[str, Any],
    payload: dict[str, Any],
    *,
    core_client: CoreClient,
    **_: Any,
) -> dict[str, Any]:
    """Ask Core to create an agent run — and stop there (ADR-0014 §4).

    This action **does not execute an agent**. It POSTs to Core's internal
    agent-run API; Core persists the run and emits ``agent.run.requested``, and
    a separate runtime subscribes to that event and does the model work. The
    orchestrator's Lambda has a 60-second timeout, so a turn loop could not run
    here even if the architecture allowed it.

    ``config`` keys: ``agent_name`` and ``instructions`` (required), ``model``
    and ``max_turns`` (defaulted from the catalog). The whole resolved config
    travels as ``definition_snapshot`` — the run's record of what it ran, which
    nothing can backfill once the definition is edited (§10).
    """
    agent_name = _require(config, "agent", "agent_name")
    _require(config, "agent", "instructions")

    snapshot: dict[str, Any] = {
        **AGENT_CONFIG_DEFAULTS,
        **{key: value for key, value in config.items() if value not in (None, "")},
    }
    causation_id, depth = _agent_chain(payload)

    try:
        run = await core_client.post(
            _AGENT_RUNS_PATH,
            json={
                "agent_name": agent_name,
                "definition_snapshot": snapshot,
                "input_payload": payload,
                "causation_id": causation_id,
                "depth": depth,
            },
        )
    except BiffoAPIError as exc:
        # Core answered, and what it answered decides whether another attempt
        # could ever help:
        #
        # - 409 is the §8 depth ceiling refusing a runaway chain. It is the most
        #   permanent refusal there is — retrying is precisely the runaway the
        #   ceiling exists to stop — and it must land as a failed run in the
        #   audit log, not a silent success: a loop guard nobody can see
        #   tripping is not a loop guard.
        # - Any other 4xx (a malformed snapshot, an unknown agent, a signature
        #   Core rejects) is equally settled.
        # - 429/5xx is Core itself being briefly unavailable, which is the one
        #   case worth another attempt.
        if _transient_status(exc.status_code):
            raise TransientActionError(
                f"Core could not create the agent run for {agent_name!r} at "
                f"depth {depth} (transient): {exc.status_code} {exc.detail}"
            ) from exc
        raise ActionError(
            f"Core refused the agent run for {agent_name!r} at depth {depth}: "
            f"{exc.status_code} {exc.detail}"
        ) from exc
    except Exception as exc:  # noqa: BLE001 — no answer from Core at all is transient
        # Not a BiffoAPIError, so Core never answered: a connect/read timeout or
        # a reset connection on the way to the internal API. Same reasoning as
        # ``_post`` — worth another attempt, unlike anything Core actually said.
        raise TransientActionError(
            f"Agent run request to Core failed for {agent_name!r}: {exc}"
        ) from exc

    run_id = (run or {}).get("id")
    if not run_id:
        raise ActionError("Core accepted the agent run but returned no run id")
    return {"run_id": run_id, "status": "requested", "depth": depth}


# action_type -> handler. The engine dispatches by this key (ADR-0003 plugin).
# Keep in step with the Core builder catalog (WORKFLOW_ACTIONS) so every
# offered action has a handler and vice versa.
ACTION_HANDLERS: dict[str, Any] = {
    "email": send_email,
    "google_chat": send_google_chat,
    "whatsapp": send_whatsapp,
    "agent": request_agent_run,
}
