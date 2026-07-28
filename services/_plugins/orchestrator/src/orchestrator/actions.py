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

import json
from collections import defaultdict
from collections.abc import Iterable
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
    """The slice of the IAM-signed Core API client the agent actions use.

    Satisfied by ``SignedCoreClient`` from the plugin SDK — the same client the
    plugin already uses to claim runs and post results (ADR-0009). The agent
    actions never build their own.

    ``get`` is here for the fan-in, which has to read a causation chain and then
    the runs in it before it can decide anything.
    """

    async def post(self, path: str, json: dict[str, Any] | None = None) -> Any: ...

    async def get(self, path: str, params: dict[str, Any] | None = None) -> Any: ...


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


def _render_recipient(action: str, field: str, value: Any, payload: dict[str, Any]) -> Any:
    """Render a recipient/target field's ``{field}`` template, same as content fields.

    A literal address (no ``{...}``) round-trips unchanged. A non-string value
    (a list, for a multi-recipient ``to``) is left untouched — templating only
    ever authors a single string. Renders to a blank/whitespace-only result
    (e.g. the trigger doesn't actually carry the referenced field) is a
    permanent failure, not a silent send to nowhere.
    """
    if not isinstance(value, str):
        return value
    rendered = _render(value, payload)
    if not rendered.strip():
        raise ActionError(
            f"{action} action_config '{field}' rendered empty — check the template "
            "references a field the trigger actually carries"
        )
    return rendered


def send_email(
    config: dict[str, Any], payload: dict[str, Any], *, ses_client: SesClient, **_: Any
) -> dict[str, Any]:
    """Send a templated email via SES.

    ``config`` keys: ``from`` (verified SES sender, required), ``to`` (address,
    address list, or a ``{field}`` template filled from the event payload —
    e.g. ``{email}`` to notify whoever triggered the run — required), ``subject``
    and ``body`` (optional ``{field}`` templates filled from the event payload).
    """
    source = _require(config, "email", "from")
    to = _render_recipient("email", "to", _require(config, "email", "to"), payload)

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


def send_slack(
    config: dict[str, Any],
    payload: dict[str, Any],
    *,
    http_client: HttpClient,
    **_: Any,
) -> dict[str, Any]:
    """Post a message to Slack via an incoming webhook.

    Mirrors :func:`send_google_chat`: ``config`` keys are ``webhook_url`` (the
    Slack incoming-webhook URL, which embeds its own secret token — required) and
    ``message`` (a ``{field}`` template filled from the event payload). Posts the
    minimal ``{"text": ...}`` body Slack's incoming webhooks accept; a non-2xx
    response is recorded as a failed run.

    The webhook URL is the credential (never an account token in the environment),
    the same shape Google Chat uses — a workflow definition carries it as a
    ``secret: True`` config field, redacted on every read (#432).
    """
    url = _require(config, "slack", "webhook_url")
    text = _render(config.get("message", ""), payload)

    response = _post(http_client, "Slack webhook", url, json={"text": text})
    if response.status_code >= 400:
        raise _http_failure("Slack webhook", response)
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
    keys: ``to`` (recipient in international format, or a ``{field}`` template
    filled from the event payload, required) and ``message_type`` —
    ``"text"`` (default) or ``"template"``.

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
    to = _render_recipient("whatsapp", "to", _require(config, "whatsapp", "to"), payload)
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
# out (ADR-0014 §10). The ``model`` default is a deliberately low-cost model
# (#414), so a definition that leaves it blank runs the cheap option rather than
# the priciest one. These two sites must stay in step (#364 tracks the drift
# hazard of duplicating the default across the package boundary).
AGENT_CONFIG_DEFAULTS: dict[str, Any] = {
    "model": "moonshotai/kimi-k3",
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
    workflow_run_id: str | None = None,
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
                # Links the agent run back to the orchestration run, and so to
                # the definition. Core needs that chain to find the principal a
                # write-back runs as (ADR-0027 §2); without it a completed run
                # has no owner and the write is refused.
                "workflow_run_id": workflow_run_id,
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


# ── Fan-in: run an agent once N parallel agents have all finished (#657) ────
#
# The engine can already fan *out* — N definitions on one trigger start N runs
# in parallel. It could not join them back: a `WorkflowDefinition` is one trigger
# to one action, so each of the N `agent.run.completed` events fires the
# follow-on independently, N times. This action is the join.
#
# It works by being deliberately near-idempotent: every sibling's completion
# fires it, and all but the last one no-op because the set is not yet complete.

TERMINAL_RUN_STATUSES = frozenset({"completed", "failed"})


def _expected_agents(config: dict[str, Any]) -> list[str]:
    """The agent names whose runs make up the set being joined."""
    raw = _require(config, "agent_fan_in", "expect_agents")
    if isinstance(raw, str):
        # An authoring form with one text input is the obvious way this gets
        # filled in — accept a comma-separated list, same as `declared_tools`.
        names = [part.strip() for part in raw.split(",")]
    elif isinstance(raw, list):
        names = [str(part).strip() for part in raw]
    else:
        raise ActionError(
            "agent_fan_in expect_agents must be a list or a comma-separated "
            f"string, got {type(raw).__name__}"
        )
    names = [name for name in names if name]
    if not names:
        raise ActionError("agent_fan_in expect_agents is empty — there is nothing to wait for")
    return names


def _terminal_run_by_agent(
    siblings: list[dict[str, Any]], expected: list[str]
) -> dict[str, dict[str, Any]] | None:
    """One terminal run per expected agent, or ``None`` if any is still pending.

    ``None`` is the wait signal, and it is the common case: with N siblings this
    returns ``None`` N-1 times and a full mapping once.

    Where an agent has several runs in the chain (a retry, say) the newest wins —
    ``list`` returns newest-first, so the first terminal one seen is the latest.
    """
    newest: dict[str, dict[str, Any]] = {}
    for run in siblings:
        name = run.get("agent_name")
        if name in expected and name not in newest and run.get("status") in TERMINAL_RUN_STATUSES:
            newest[name] = run
    missing = [name for name in expected if name not in newest]
    if missing:
        return None
    return newest


async def fan_in_agent_runs(
    config: dict[str, Any],
    payload: dict[str, Any],
    *,
    core_client: CoreClient,
    **_: Any,
) -> dict[str, Any]:
    """Run an agent over the outputs of a set of parallel agents, once they finish.

    Triggered by ``agent.run.completed``. Reads the chain off the event
    (``causation_id``), asks Core which runs share it (#656), and:

    - **no-ops** while any agent in ``expect_agents`` has no terminal run yet;
    - **no-ops** if a run for ``agent_name`` already exists in this chain — the
      idempotency guard, see below;
    - otherwise fetches each expected run in full and starts ``agent_name`` with
      their outputs in ``input_payload``.

    ``config`` keys: ``expect_agents`` and ``agent_name`` and ``instructions``
    (required), ``model`` and ``max_turns`` (defaulted from the catalog, like the
    plain ``agent`` action).

    **A failed sibling is still terminal.** The join proceeds and simply carries
    no output for it, because a workflow that fans out to redundant angles wants
    a degraded answer rather than a hang. If *every* expected run failed there is
    nothing to work from and the action fails loudly instead of starting an agent
    with an empty payload.

    **On the idempotency guard.** Sibling completions can race: two arriving
    together can both observe a complete set, and each duplicate is a real
    invoice. The engine's own `WorkflowRun.dedupe_key` does not help here — it is
    keyed per *event*, and these are genuinely different events, which is exactly
    why they each get a run. So the guard is a check for an existing run of
    ``agent_name`` in the chain, made as late as possible. That closes the
    ordinary case (siblings finishing seconds or minutes apart) but leaves a
    narrow window where two simultaneous completions both find nothing and both
    fire. It fails safe — a duplicate follow-on run, never a loop, and §8's depth
    ceiling still bounds the chain. Closing it properly needs an atomic
    create-once in Core; tracked in #661.
    """
    expected = _expected_agents(config)
    agent_name = _require(config, "agent_fan_in", "agent_name")
    _require(config, "agent_fan_in", "instructions")

    causation_id, depth = _agent_chain(payload)
    if causation_id is None:
        raise ActionError(
            "agent_fan_in needs a chained trigger: the event carried no run_id/depth, "
            "so there is no causation chain to join. Trigger it from agent.run.completed."
        )

    siblings = await _get_chain(core_client, causation_id=causation_id)
    terminal = _terminal_run_by_agent(siblings, expected)
    if terminal is None:
        return {"status": "waiting", "causation_id": causation_id, "expected": expected}

    # The guard — deliberately re-read rather than derived from `siblings`, so the
    # window between deciding and firing is as small as it can be.
    already = await _get_chain(core_client, causation_id=causation_id, agent_name=agent_name)
    if already:
        return {
            "status": "already_fired",
            "causation_id": causation_id,
            "run_id": already[0].get("id"),
        }

    # Only completed siblings are fetched, and both the outputs and the shared
    # context are derived from those.
    #
    # Reading the failed ones too was the first attempt — a sibling that failed
    # was still *told* the same thing, so it is an equally good witness to the
    # briefing. It is not worth it: it adds an HTTP call per failed sibling and,
    # with it, a fresh way for the join to fail transiently on a run it does not
    # actually need. The action already refuses to proceed with no completed
    # sibling, so there is always at least one witness left.
    #
    # The honest consequence: `context` is what every *contributing* sibling was
    # given, not literally every sibling. For a fan-out briefed once and split by
    # angle — the shape this exists for — those are the same thing.
    fulls: dict[str, dict[str, Any]] = {}
    for name, summary in terminal.items():
        if summary.get("status") != "completed":
            continue  # failed sibling: terminal, but has nothing to contribute
        run_id = summary.get("id")
        if not run_id:
            continue
        fulls[name] = await _get_run(core_client, run_id=str(run_id))

    outputs: dict[str, Any] = {name: _delivery_output(full) for name, full in fulls.items()}

    if not outputs:
        raise ActionError(
            f"agent_fan_in has nothing to run {agent_name!r} on: every agent in "
            f"{expected} failed in chain {causation_id}"
        )

    shared = _shared_input(fulls.values())

    snapshot: dict[str, Any] = {
        **AGENT_CONFIG_DEFAULTS,
        **{
            key: value
            for key, value in config.items()
            if value not in (None, "") and key != "expect_agents"
        },
    }
    try:
        run = await core_client.post(
            _AGENT_RUNS_PATH,
            json={
                "agent_name": agent_name,
                "definition_snapshot": snapshot,
                # The joined outputs, keyed by which agent produced each, plus the
                # completion that happened to trip the join — a handler that wants
                # to know what it was reacting to still can — plus whatever the
                # whole fan-out was briefed with (see `_shared_input`).
                "input_payload": {
                    "fan_in": outputs,
                    "trigger": payload,
                    **({"context": shared} if shared else {}),
                },
                "causation_id": causation_id,
                "depth": depth,
            },
        )
    except BiffoAPIError as exc:
        if _transient_status(exc.status_code):
            raise TransientActionError(
                f"Core could not create the fan-in run for {agent_name!r} at "
                f"depth {depth} (transient): {exc.status_code} {exc.detail}"
            ) from exc
        raise ActionError(
            f"Core refused the fan-in run for {agent_name!r} at depth {depth}: "
            f"{exc.status_code} {exc.detail}"
        ) from exc
    except Exception as exc:  # noqa: BLE001 — no answer at all is transient
        raise TransientActionError(
            f"Fan-in run request to Core failed for {agent_name!r}: {exc}"
        ) from exc

    run_id = (run or {}).get("id")
    if not run_id:
        raise ActionError("Core accepted the fan-in run but returned no run id")
    return {
        "run_id": run_id,
        "status": "requested",
        "depth": depth,
        "joined": sorted(outputs),
    }


async def _get_chain(
    core_client: CoreClient, *, causation_id: str, agent_name: str | None = None
) -> list[dict[str, Any]]:
    """Run summaries sharing a causation chain (#656), newest first."""
    params = {"causation_id": causation_id}
    if agent_name is not None:
        params["agent_name"] = agent_name
    try:
        rows = await core_client.get(_AGENT_RUNS_PATH, params=params)
    except BiffoAPIError as exc:
        raise TransientActionError(
            f"Could not read causation chain {causation_id}: {exc.status_code} {exc.detail}"
        ) from exc
    return list(rows or [])


async def _get_run(core_client: CoreClient, *, run_id: str) -> dict[str, Any]:
    """One run in full — the summaries from ``_get_chain`` carry no output."""
    try:
        return await core_client.get(f"{_AGENT_RUNS_PATH}/{run_id}") or {}
    except BiffoAPIError as exc:
        raise TransientActionError(
            f"Could not read agent run {run_id}: {exc.status_code} {exc.detail}"
        ) from exc


# action_type -> handler. The engine dispatches by this key (ADR-0003 plugin).
# Keep in step with the Core builder catalog (WORKFLOW_ACTIONS) so every
# offered action has a handler and vice versa.
ACTION_HANDLERS: dict[str, Any] = {
    "email": send_email,
    "google_chat": send_google_chat,
    "slack": send_slack,
    "whatsapp": send_whatsapp,
    "agent": request_agent_run,
    "agent_fan_in": fan_in_agent_runs,
}


# ── Deliver an agent's result on completion (ADR-0020, #527) ─────────────────
#
# An agent action's `action_config` may carry an optional `delivery` sub-config,
# snapshotted onto the run. On `agent.run.completed` for a *succeeded* run the
# orchestrator renders the run's output into the destination and reuses the
# executor above — so the same code serves a standalone action and delivery.

# The one field of each destination that carries the human message. When a
# delivery leaves it unset it defaults to the {output} placeholder, so the raw
# agent result is sent. Mirrors the Core catalog's `output_body: True` markers.
DELIVERY_BODY_FIELDS: dict[str, str] = {
    "email": "body",
    "slack": "message",
    "google_chat": "message",
    "whatsapp": "message",
}


def _shared_input(runs: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """What every agent in the fan-out was given — the run's shared briefing.

    A fan-in agent reasons over its siblings' *outputs*, and until now that was
    all it got. But the thing those outputs are about — who the work is for,
    what was asked — lives in the siblings' `input_payload`, which this action
    already fetches in full and then discarded. An agent asked to weigh a
    founder's profile was never given one, and said so
    (biffo-plugin-idea-scout#26).

    Only keys **every** contributing sibling carries with an equal value survive. That is the
    whole definition: shared means shared. A key one sibling holds privately —
    its own angle, its own instructions — is not context about the fan-out and
    must not reach the joining agent dressed as if it were.

    Returns `{}` when the siblings agree on nothing, and the caller then omits
    the key rather than sending an empty object.
    """
    payloads = [r.get("input_payload") for r in runs]
    dicts = [p for p in payloads if isinstance(p, dict)]
    if not dicts:
        return {}
    first, *rest = dicts
    return {
        key: value
        for key, value in first.items()
        if all(key in other and other[key] == value for other in rest)
    }


def _delivery_output(run: dict[str, Any]) -> str:
    """The agent result to render as ``{output}``.

    A completed run's ``result`` is ``{"output": <text>, …}`` (the model's final
    content) or, on the submit-tool path, a structured dict with no ``output`` key.
    Prefer the plain ``output`` string; otherwise serialise the whole result so a
    tool-shaped result still delivers something legible rather than nothing.
    """
    result = run.get("result")
    if isinstance(result, dict):
        output = result.get("output")
        if isinstance(output, str):
            return output
        if output is not None:
            return json.dumps(output)
        return json.dumps(result)
    if result is None:
        return ""
    return str(result)


def prepare_delivery(
    delivery: Any, run: dict[str, Any]
) -> tuple[str, dict[str, Any], dict[str, Any]] | None:
    """Resolve a run's ``delivery`` sub-config into an executable dispatch.

    Returns ``(action_type, config, payload)`` — the destination's action type, a
    config whose ``output_body`` field is defaulted to ``{output}`` when the author
    gave no template, and the render payload exposing ``{output}`` plus a little run
    metadata (``{agent}``/``{run_id}``/``{status}``). Returns ``None`` when there is
    nothing to deliver: no delivery config, a malformed one, or an unknown type.
    The message is rendered by the executor itself (via ``_render``), so a template
    such as ``"Result: {output}"`` fills exactly as an event-payload template does.
    """
    if not isinstance(delivery, dict):
        return None
    action_type = delivery.get("type")
    if action_type not in DELIVERY_BODY_FIELDS or action_type not in ACTION_HANDLERS:
        return None
    config = dict(delivery.get("config") or {})
    body_field = DELIVERY_BODY_FIELDS[action_type]
    if not (isinstance(config.get(body_field), str) and config[body_field].strip()):
        config[body_field] = "{output}"
    payload = {
        "output": _delivery_output(run),
        "agent": run.get("agent_name"),
        "run_id": run.get("id"),
        "status": run.get("status"),
    }
    return str(action_type), config, payload
