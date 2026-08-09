"""OrchestratorPlugin — the engine's BiffoPluginBase implementation.

On a subscribed event it: (1) posts the event to the Core internal API, which
matches enabled workflow definitions and idempotently claims one run each;
(2) executes the action for every *newly claimed* run (skipping replays);
(3) records each outcome back to Core.

State lives in Core (ADR-0002); this plugin holds none. It reaches Core over the
IAM-signed internal API (ADR-0009) via ``SignedCoreClient``.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import uuid
from datetime import UTC, datetime
from typing import Any

import boto3
import httpx
from aws_lambda_powertools import Logger
from biffo_plugin_sdk import (
    BiffoAPIClient,
    BiffoAPIError,
    BiffoEvent,
    BiffoPluginBase,
    SignedCoreClient,
    load_manifest,
)

from .actions import (
    ACTION_HANDLERS,
    TransientActionError,
    WhatsAppSettings,
    prepare_delivery,
)
from .email_branding import EmailBranding
from .manifest import MANIFEST_PATH

logger = Logger()

_INTERNAL_BASE = "/api/v1/internal/orchestration"
# The internal agent-run API (ADR-0009). The completion event carries only a
# reference (ADR-0014 §5), so delivery-on-completion (ADR-0020) fetches the run —
# its output and its delivery snapshot — over the authenticated internal API.
_AGENT_RUNS_BASE = "/api/v1/internal/agent-runs"
# The detail_type the deliver-on-completion handler reacts to.
_AGENT_RUN_COMPLETED = "agent.run.completed"
# Bounded in-process retry for transient action failures. Worst case is
# 3 × the 10s HTTP timeout plus 1.5s of backoff — comfortably inside the
# engine Lambda's 60s timeout, with room for the Core API calls either side.
_MAX_ATTEMPTS = 3
_BACKOFF_SECONDS = (0.5, 1.0)
# Payload keys, in preference order, used as the event's idempotency key.
_ID_KEYS = ("demo_request_id", "id", "lead_id")

# Scheduled workflow actions (docs/implementation/0002-scheduled-workflow-actions,
# ADR-0023). The sentinel key on a raw Lambda invocation from EventBridge
# Scheduler's own Target.Input — never an EventBridge-rule-shaped event, so
# main.py's handler checks for this key *before* `create_event_handler`, which
# requires a source/detail-type/detail envelope and would raise on this shape.
SCHEDULED_RUN_ID_KEY = "biffo_scheduled_run_id"
_SCHEDULE_NAME_PREFIX = "wf-run-"

# Stale-run sweep (tabsii-platform#808, mirroring agent-runtime's own
# AGENT_RUNS_REAP_DUE exactly — same shape, same reason: this plugin's own
# scheduled EventBridge rule (terraform/), synthesising the BiffoEvent
# envelope `create_event_handler` expects, so it arrives through the same
# `plugin.events.dispatch` path as a real bus event and needs no second
# entrypoint in main.py. The source is this plugin's own, never biffo.core —
# Core did not emit this. It carries no payload: the sweep's subject is
# "whatever is stale now", which only Core can know.
ORCHESTRATION_RUNS_REAP_DUE = "orchestration.runs.reap_due"
ORCHESTRATOR_SOURCE = "biffo.orchestrator"


def _schedule_name(run_id: str) -> str:
    return f"{_SCHEDULE_NAME_PREFIX}{run_id}"


def _at_expression(scheduled_for: str) -> str:
    """EventBridge Scheduler's ``at()`` syntax: a local timestamp with no
    timezone suffix, interpreted in the schedule's timezone (UTC, the
    default, left unset). Core always returns an already-UTC instant."""
    dt = datetime.fromisoformat(scheduled_for)
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def _idempotency_key(event: BiffoEvent) -> str:
    """A stable key identifying this event, so a replay claims the same runs.

    Prefers an explicit id in the payload; falls back to a content hash so an
    event with no obvious id is still deduplicated against its own replays.

    An **empty** payload is not "an id-less event with stable content" — it is
    "no signal at all about which occurrence this is" (tabsii-platform#808). A
    periodic tick (``orchestrator.tick``, ``docs/implementation`` — the payload
    is deliberately empty, see ``OrchestratorTickPayload``) fires on an
    unchanging (source, detail_type) with an unchanging ``{}`` payload, so the
    content-hash fallback below would compute the *same* digest on every single
    firing, forever. Fed into ``_claim_run``'s dedupe_key, that collapsed every
    tick after the very first one into ``created=False`` — "already claimed" —
    for as long as the definition existed, regardless of whether the first run
    ever completed. Every workflow bound to the tick (KPI rollup, the finance
    sweep, retention sweeps) went permanently dark after its first hour on dev,
    invisible to `test_every_finance_batch_endpoint_has_a_workflow_binding`
    (#723) because that guard checks the binding is authored, never that it
    fires.

    So: no id, no payload → treat this occurrence as inherently unique rather
    than hash "nothing" into a key that collides with every other occurrence of
    "nothing". This trades away replay-dedup for this shape of event, but nothing
    is lost by it — the domain handlers a tick binds to are documented and built
    to be idempotent themselves (e.g. calendar-day upserts, "the tick guarantees
    repetition"), because at-least-once delivery already meant they had to
    tolerate more than one firing per nominal tick. Dedup for events that DO
    carry payload content is unchanged below.
    """
    payload = event.payload
    for key in _ID_KEYS:
        value = payload.get(key)
        if value:
            return str(value)
    if not payload:
        return f"{event.detail_type}:{uuid.uuid4()}"
    digest = hashlib.sha256(
        json.dumps({"d": event.detail_type, "p": payload}, sort_keys=True, default=str).encode()
    ).hexdigest()
    return f"{event.detail_type}:{digest}"


def _whatsapp_from_ssm(ssm_client: Any | None) -> WhatsAppSettings:
    """Resolve the WhatsApp credentials from SSM, once per cold start.

    The Lambda carries only the *parameter names*, so the token is never in the
    function's configuration or in Terraform state. Unset names mean the action
    is not configured — the handler then fails the run with a clear message
    rather than the engine failing to start. A fetch that errors (parameter
    missing, permission denied) is logged and treated the same way, so a broken
    WhatsApp setup can never stop email, Chat or agent workflows from running.
    """
    token_parameter = os.environ.get("WHATSAPP_ACCESS_TOKEN_PARAMETER", "")
    number_parameter = os.environ.get("WHATSAPP_PHONE_NUMBER_ID_PARAMETER", "")
    api_version = os.environ.get("WHATSAPP_API_VERSION", "v22.0")

    if not (token_parameter and number_parameter):
        return WhatsAppSettings("", "", api_version)

    client = ssm_client if ssm_client is not None else boto3.client("ssm")

    def _get(name: str) -> str:
        response = client.get_parameter(Name=name, WithDecryption=True)
        return str(response["Parameter"]["Value"])

    try:
        return WhatsAppSettings(
            access_token=_get(token_parameter),
            phone_number_id=_get(number_parameter),
            api_version=api_version,
        )
    except Exception:  # noqa: BLE001 — a broken WhatsApp setup must not break the engine
        logger.exception(
            "Could not read the WhatsApp credentials from SSM; "
            "the whatsapp action will report itself unconfigured",
            extra={"access_token_parameter": token_parameter},
        )
        return WhatsAppSettings("", "", api_version)


class OrchestratorPlugin(BiffoPluginBase):
    """Event-driven orchestration engine — core platform capability (ADR-0010/ADR-0014),
    not an optional plugin.

    Uses the ADR-0003 manifest mechanism for plugin discovery and registration,
    but is first-party and template-owned, distributed by biffo core upgrade.
    """

    def __init__(
        self,
        api: BiffoAPIClient | None = None,
        ses_client: Any | None = None,
        http_client: Any | None = None,
        whatsapp: WhatsAppSettings | None = None,
        ssm_client: Any | None = None,
        scheduler_client: Any | None = None,
        branding: EmailBranding | None = None,
    ) -> None:
        manifest = load_manifest(MANIFEST_PATH)
        super().__init__(manifest, api=api if api is not None else SignedCoreClient())
        # SESv2, not classic SES: only SESv2's `send_email` can set custom
        # headers (`Content.Simple.Headers`), which is what lets the `email`
        # action attach RFC 8058 `List-Unsubscribe`/`List-Unsubscribe-Post`
        # (see `SesClient` in actions.py). The IAM action names are unchanged
        # (`ses:SendEmail`/`ses:SendRawEmail` cover both API generations), so
        # no Terraform change accompanies this.
        self._ses = ses_client if ses_client is not None else boto3.client("sesv2")
        # Plain (unsigned) HTTP client for webhook actions — distinct from the
        # IAM-signed Core client. Reused across warm invocations to pool connections.
        self._http = http_client if http_client is not None else httpx.Client(timeout=10)
        # Creates the engine's own one-time schedules for a delayed run
        # (ADR-0023). Terraform grants scheduler:CreateSchedule/DeleteSchedule/
        # GetSchedule scoped to this plugin's own schedule group only. Built
        # lazily (unlike `self._ses` above): `boto3.client("scheduler")`
        # validates a region at construction time, unlike `ses`, so
        # constructing it unconditionally here breaks every test that never
        # schedules anything and has no AWS region configured (CI has none —
        # the same NoRegionError class this codebase already hit with a real
        # EventPublisher). Most workflows never delay, so most invocations
        # never need this client at all.
        self._scheduler = scheduler_client
        # Account-level WhatsApp credentials: read once per cold start from SSM,
        # never from a workflow's action_config (which is stored in the DB) and
        # never from an env var (which shows in the function's config).
        self._whatsapp = whatsapp or _whatsapp_from_ssm(ssm_client)
        # The shared branded email layout's configurable surface (issue
        # tabsii-platform#378) — read once from the environment at cold start,
        # like the WhatsApp credentials above, and threaded through every
        # `email` dispatch (`_execute_run`/`_deliver`) rather than re-read per
        # invocation.
        self._branding = branding if branding is not None else EmailBranding.from_env()

        # Generic forwarder: react to *every* event and let Core decide what to
        # do (match it against enabled workflow definitions). Adding a new trigger
        # is then just a workflow definition — no plugin code change, no per-event
        # subscription to keep in sync (ADR-0010, epic #210). The broad EventBridge
        # rule is what delivers all events to this Lambda (#214).
        @self.subscribe_all()
        async def _forward(event: BiffoEvent) -> None:
            if (
                event.source == ORCHESTRATOR_SOURCE
                and event.detail_type == ORCHESTRATION_RUNS_REAP_DUE
            ):
                # This plugin's own internal reap signal, not a bus event a
                # workflow could ever legitimately trigger on — `_on_reap_due`
                # below handles it directly. Forwarding it here too would run
                # it through `process_event` -> `dispatch_event` ->
                # `observe_trigger`, offering it to the builder as a
                # selectable trigger. `_schedule_run`'s docstring flags exactly
                # this concern for the scheduled-run fire callback, which is
                # why that one bypasses dispatch entirely instead; this event
                # does travel the normal BiffoEvent/dispatch path (so it still
                # gets the standard "Received event" log line) but must stop
                # here rather than reach Core's trigger catalog.
                return
            await self.process_event(event)

        # Deliver an agent's result on completion (ADR-0020, #527). A dedicated
        # subscription for `agent.run.completed`, additional to the wildcard
        # forwarder above: the dispatcher runs detail-type handlers *and* wildcard
        # handlers, so this reacts to the completion event without disturbing the
        # generic forwarding that lets a workflow trigger on the same event (agent
        # chaining). No change to event dispatch was needed.
        @self.subscribe(_AGENT_RUN_COMPLETED)
        async def _deliver(event: BiffoEvent) -> None:
            await self.deliver_on_completion(event)

        # Stale-run sweep (tabsii-platform#808). Unlike `_deliver` above, this
        # is deliberately NOT left to coexist with the wildcard forwarder: see
        # `_forward`'s own exclusion of this (source, detail_type) pair, and
        # why — this event must not reach `dispatch_event`/`observe_trigger`.
        @self.subscribe(ORCHESTRATION_RUNS_REAP_DUE, source=ORCHESTRATOR_SOURCE)
        async def _on_reap_due(event: BiffoEvent) -> None:
            await self.reap_stale_runs()

    def on_install(self) -> None:
        """No-op, and **not invoked** — nothing calls the lifecycle hooks
        (biffo-template#709). Workflow definitions are seeded out-of-band (DDL
        import) regardless, not via an API this plugin owns — orchestration
        tables are Core-owned and not exposed as generic CRUD."""
        return None

    def on_uninstall(self) -> None:
        """No-op, and not invoked (see :meth:`on_install`)."""
        return None

    async def process_event(self, event: BiffoEvent) -> None:
        """Claim runs for the event in Core, then execute the newly-claimed ones."""
        response = await self.api.post(
            f"{_INTERNAL_BASE}/events",
            json={
                "source": event.source,
                "detail_type": event.detail_type,
                "idempotency_key": _idempotency_key(event),
                "event": event.payload,
            },
        )
        runs = (response or {}).get("runs", [])
        for run in runs:
            if not run.get("created"):
                logger.info(
                    "Skipping already-claimed run",
                    extra={"run_id": run.get("run_id")},
                )
                continue
            if run.get("scheduled_for"):
                # A delayed definition (ADR-0023): schedule the future fire
                # rather than executing now.
                await self._schedule_run(run)
                continue
            await self._execute_run(run, event.payload)

    async def _schedule_run(self, run: dict[str, Any]) -> None:
        """Create a one-time EventBridge Scheduler schedule for a delayed run
        (docs/implementation/0002-scheduled-workflow-actions, ADR-0023).

        Targets this Lambda's own ARN with a small sentinel payload —
        ``main.py``'s handler detects it and routes straight to
        ``fire_scheduled_run``, bypassing the ``BiffoEvent``/subscribe
        machinery entirely: this callback is not a bus event and must not be
        treated as one (it would otherwise flow through ``process_event`` →
        Core's ``observe_trigger``, polluting the self-building trigger
        catalog with an internal signal no one should select as a trigger).
        ``ActionAfterCompletion="DELETE"`` means the schedule cleans itself
        up after firing — no follow-up ``DeleteSchedule`` call needed.
        """
        run_id = run["run_id"]
        if self._scheduler is None:
            self._scheduler = boto3.client("scheduler")
        self._scheduler.create_schedule(
            Name=_schedule_name(run_id),
            GroupName=os.environ.get("BIFFO_SCHEDULE_GROUP_NAME", "default"),
            ScheduleExpression=f"at({_at_expression(run['scheduled_for'])})",
            FlexibleTimeWindow={"Mode": "OFF"},
            Target={
                "Arn": os.environ.get("BIFFO_FUNCTION_ARN", ""),
                "RoleArn": os.environ.get("BIFFO_SCHEDULER_ROLE_ARN", ""),
                "Input": json.dumps({SCHEDULED_RUN_ID_KEY: run_id}),
            },
            ActionAfterCompletion="DELETE",
        )
        logger.info(
            "Scheduled a delayed run",
            extra={"run_id": run_id, "scheduled_for": run["scheduled_for"]},
        )

    async def fire_scheduled_run(self, run_id: str) -> None:
        """The fire-time callback for a scheduled run (ADR-0023).

        Invoked directly by ``main.py``'s handler on the Scheduler's raw
        Lambda-target payload — never through the event-subscription system.
        Claims the run from Core (guards EventBridge's at-least-once delivery
        from double-firing, and re-checks the definition is still enabled/
        exists); ``claimed=False`` means there is nothing to execute.
        """
        response = await self.api.post(f"{_INTERNAL_BASE}/runs/{run_id}/fire")
        if not (response or {}).get("claimed"):
            logger.info(
                "Scheduled run not claimed (already fired, or its definition was disabled/deleted)",
                extra={"run_id": run_id},
            )
            return
        run = {
            "run_id": response["run_id"],
            "action_type": response["action_type"],
            "action_config": response.get("action_config") or {},
        }
        payload = response.get("trigger_event") or {}
        await self._execute_run(run, payload)

    async def reap_stale_runs(self) -> None:
        """Ask Core to fail runs a dead invocation left claimed (tabsii-platform#808).

        All the work is Core's: it owns the runs, the clock and the threshold
        (mirrors ``AgentRuntimePlugin.reap_stale_runs`` exactly). This is only
        the schedule tick — the plugin holds no state and makes no decision
        about what is stale.

        A failure here is logged and swallowed, not raised: raising would fail
        the Lambda invocation and trigger an EventBridge retry against a Core
        that may already be unwell, whereas the sweep costs nothing to skip —
        it runs again on the next tick.
        """
        try:
            reaped = await self.api.post(f"{_INTERNAL_BASE}/reap", json={})
        except BiffoAPIError:
            logger.exception(
                "Stale orchestration-run sweep failed; will retry on the next schedule"
            )
            return

        count = len(reaped) if isinstance(reaped, list) else 0
        if count:
            logger.warning("Reaped stale orchestration runs", extra={"count": count})

    async def deliver_on_completion(self, event: BiffoEvent) -> None:
        """Deliver a *succeeded* agent run's result to its destination (ADR-0020).

        Reacts to ``agent.run.completed``. The completion event is a reference only
        (ADR-0014 §5) — the output and the ``definition_snapshot`` that carries the
        delivery config are LLM-derived and stay behind the authenticated fetch — so
        the run is read over the internal API. When the snapshot carries a
        ``delivery`` sub-config, ``{output}`` is rendered into the destination and
        the matching executor (the same one a standalone action uses) is invoked.

        Delivers **nothing** when: the run did not succeed (see the failure-notify
        seam below), there is no delivery config, or the delivery config is
        unusable. Delivery is best-effort and out-of-band — there is no workflow run
        to record against — so its outcome is logged, not written to the audit log.
        """
        payload = event.payload
        # ── Failure-notify seam (ADR-0020, deferred) ────────────────────────────
        # The MVP delivers only on a succeeded run. When failure notification lands
        # it branches here — a `delivery` may then declare an on-failure destination
        # or template — *before* the succeeded-only gate. Until then a failed (or
        # reaped) run is a deliberate no-op.
        if payload.get("status") != "completed":
            return
        run_id = payload.get("run_id")
        if not run_id:
            return

        run = await self.api.get(f"{_AGENT_RUNS_BASE}/{run_id}")
        snapshot = (run or {}).get("definition_snapshot") or {}

        # Record the result into the table the workflow declared (ADR-0027).
        # Independent of message delivery below: a workflow may do both, and one
        # failing must not suppress the other. This plugin knows nothing about
        # the table, the columns, the values or the principal — it says only
        # which run finished, and Core resolves the rest from stored state.
        if snapshot.get("writeback"):
            await self._write_back(str(run_id))

        prepared = prepare_delivery(snapshot.get("delivery"), run or {})
        if prepared is None:
            # No delivery configured, or a delivery this engine can't dispatch —
            # today's behaviour: the run completes and nothing else happens.
            return

        action_type, config, delivery_payload = prepared
        await self._deliver(str(run_id), action_type, config, delivery_payload)

    async def _write_back(self, agent_run_id: str) -> None:
        """Ask Core to record a completed run's result.

        Best-effort and bounded, like delivery: Core claims the write against the
        agent run before performing it, so a retry here cannot double-write. A
        denial comes back as a normal 200 with a status — the engine has nothing
        to do about it, and Core has already recorded it where the run history
        will show it.
        """
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                result = await self.api.post(
                    f"{_INTERNAL_BASE}/writeback", json={"agent_run_id": agent_run_id}
                )
            except Exception:  # noqa: BLE001 — never let a write-back fail the invocation
                if attempt == _MAX_ATTEMPTS:
                    logger.exception(
                        "Write-back request failed after retries",
                        extra={"agent_run_id": agent_run_id, "attempts": attempt},
                    )
                    return
                await asyncio.sleep(_BACKOFF_SECONDS[attempt - 1])
                continue
            logger.info(
                "Write-back recorded",
                extra={
                    "agent_run_id": agent_run_id,
                    "status": (result or {}).get("status"),
                    "reason": (result or {}).get("reason"),
                },
            )
            return

    async def _deliver(
        self,
        run_id: str,
        action_type: str,
        config: dict[str, Any],
        payload: dict[str, Any],
    ) -> None:
        """Invoke a delivery destination's executor, retrying transient failures.

        Reuses the action executors (``ACTION_HANDLERS``) and the same transient/
        permanent split and bounded in-process retry as ``_execute_run``; unlike a
        workflow action there is no claimed run to record the outcome against, so a
        failure is logged rather than recorded. A permanent failure (a bad webhook,
        a rejected recipient) is not retried.
        """
        handler = ACTION_HANDLERS.get(action_type)
        if handler is None:
            logger.warning(
                "Delivery skipped: no executor for destination",
                extra={"run_id": run_id, "delivery_type": action_type},
            )
            return

        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                result = handler(
                    config,
                    payload,
                    ses_client=self._ses,
                    http_client=self._http,
                    core_client=self.api,
                    whatsapp=self._whatsapp,
                    branding=self._branding,
                )
                if inspect.isawaitable(result):
                    result = await result
            except TransientActionError:
                if attempt == _MAX_ATTEMPTS:
                    logger.warning(
                        "Delivery failed after retries",
                        extra={"run_id": run_id, "delivery_type": action_type, "attempts": attempt},
                    )
                    return
                await asyncio.sleep(_BACKOFF_SECONDS[attempt - 1])
                continue
            except Exception:  # noqa: BLE001 — permanent: log, don't retry or crash
                logger.exception(
                    "Delivery failed",
                    extra={"run_id": run_id, "delivery_type": action_type},
                )
                return
            logger.info(
                "Delivered agent result on completion",
                extra={"run_id": run_id, "delivery_type": action_type, "attempts": attempt},
            )
            return

    async def _execute_run(self, run: dict[str, Any], payload: dict[str, Any]) -> None:
        """Run a claimed run's action now.

        ``payload`` is the triggering event's payload — the *live* event for
        an immediate dispatch (``process_event``), or the *stored*
        ``trigger_event`` Core hands back for a scheduled run's fire-time
        callback (``fire_scheduled_run``, ADR-0023) — template rendering
        needs the same payload either way, it just may be days or weeks old
        in the second case.
        """
        run_id = run["run_id"]
        action_type = run["action_type"]
        config = run.get("action_config") or {}

        handler = ACTION_HANDLERS.get(action_type)
        if handler is None:
            await self._record(
                run_id,
                action_type,
                "failed",
                error=f"Unknown action_type: {action_type}",
            )
            return

        # Retry in-process rather than by failing the invocation: the run was
        # already claimed in Core before the action ran, so a redelivered event
        # comes back created=False and would be skipped. This loop is the only
        # thing standing between a transient 503 and a permanently failed run.
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                result = handler(
                    config,
                    payload,
                    ses_client=self._ses,
                    http_client=self._http,
                    core_client=self.api,
                    whatsapp=self._whatsapp,
                    branding=self._branding,
                    # The orchestration run this action belongs to. The agent
                    # action passes it to Core so a completed run can be traced
                    # back to the definition that requested it — which is how
                    # write-back finds the principal to act as (ADR-0027 §2).
                    # Handlers that don't need it absorb it via **_.
                    workflow_run_id=run_id,
                )
                # Handlers whose side effect is an await-only call (the agent
                # action POSTs to Core through the async signed client) are
                # `async def`. Awaiting here rather than in every handler keeps
                # registration and the sync handlers unchanged — and the await
                # must sit inside the try, since an async handler raises when it
                # is awaited, not when it is called.
                if inspect.isawaitable(result):
                    result = await result
            except TransientActionError as exc:
                if attempt == _MAX_ATTEMPTS:
                    logger.warning(
                        "Action failed after retries",
                        extra={"run_id": run_id, "attempts": attempt},
                    )
                    await self._record(
                        run_id,
                        action_type,
                        "failed",
                        request=config,
                        error=f"{exc} (after {attempt} attempts)",
                    )
                    return
                logger.info(
                    "Retrying transient action failure",
                    extra={"run_id": run_id, "attempt": attempt},
                )
                await asyncio.sleep(_BACKOFF_SECONDS[attempt - 1])
                continue
            except Exception as exc:  # noqa: BLE001 — permanent: record, don't retry
                logger.exception("Action dispatch failed", extra={"run_id": run_id})
                await self._record(run_id, action_type, "failed", request=config, error=str(exc))
                return

            await self._record(
                run_id,
                action_type,
                "succeeded",
                request=config,
                response={**result, "attempts": attempt},
            )
            return

    async def _record(
        self,
        run_id: str,
        action_type: str,
        status: str,
        *,
        request: dict[str, Any] | None = None,
        response: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        await self.api.post(
            f"{_INTERNAL_BASE}/runs/{run_id}/result",
            json={
                "action_type": action_type,
                "status": status,
                "request": request,
                "response": response,
                "error": error,
            },
        )
