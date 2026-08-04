import json
from dataclasses import dataclass
from typing import Any

import boto3
from aws_lambda_powertools import Logger
from pydantic import BaseModel, Field

from ..config import settings

logger = Logger()


@dataclass(frozen=True)
class PublishOutcome:
    """What actually happened on a single ``put_events`` call (biffo-template#1017).

    Distinguishes the one thing the publish boundary can know for certain — did
    EventBridge's API accept this entry onto the bus — from everything past it
    (rule matching, target delivery, throttling), which this boundary cannot see.

    ``accepted`` is True only when the API call returned with
    ``FailedEntryCount == 0``. ``event_id`` is EventBridge's own id for the
    accepted entry (``Entries[0].EventId``) — the correlator that lets a reader
    verify this exact publish reached the bus, as opposed to some other attempt.
    ``error_code``/``error_message`` are populated on a rejected entry
    (``Entries[0].ErrorCode``/``ErrorMessage``, e.g. ``"ThrottlingException"``)
    or, when the API call itself failed (network, auth, unreachable), the
    caught exception's type name and message respectively — so "the call never
    reached EventBridge" and "EventBridge rejected the entry" both surface a
    reason rather than a bare False.
    """

    accepted: bool
    event_id: str | None = None
    error_code: str | None = None
    error_message: str | None = None


class BiffoEvent(BaseModel):
    """
    Base model for all events published to EventBridge (ADR-0002).

    Every event must carry tenant_id and schema_version.
    Consumers must handle schema version changes gracefully.
    """

    source: str = "biffo.core"
    detail_type: str
    schema_version: str = "1.0"
    tenant_id: str = Field(default="default")
    payload: dict[str, Any]

    def to_eventbridge_entry(self, bus_name: str) -> dict[str, Any]:
        return {
            "Source": self.source,
            "DetailType": self.detail_type,
            "Detail": json.dumps(
                {
                    "schema_version": self.schema_version,
                    "tenant_id": self.tenant_id,
                    "payload": self.payload,
                }
            ),
            "EventBusName": bus_name,
        }


class EventPublisher:
    def __init__(self) -> None:
        self._client = boto3.client("events")

    def publish(self, event: BiffoEvent) -> PublishOutcome:
        """Publish an event to EventBridge. Best-effort: never raises, so that API
        requests succeed even when EventBridge is unreachable (e.g. dev
        environments without NAT or a VPC endpoint) — a rolled-back transaction is
        the only thing that should stop an event, not a downstream outage.

        Every attempt is logged with a ``run_id`` correlator (biffo-template#1017)
        when the payload carries one — which ``agent.run.requested`` always does
        (:func:`api.agent_runs.run_reference_payload`) — so a reader investigating
        one run can grep this log for exactly its publish attempt rather than
        every event this process ever sent. Generic rather than agent-specific:
        this is the one publish path for every event type in the codebase, and a
        second, agent-only copy of this logging is exactly the kind of duplicate
        logic this estate has already paid for once (``_extract_detail``).

        Returns a :class:`PublishOutcome` so a caller that has somewhere to put
        the answer — the reaper's stored ``error`` text, a future outbox — can
        act on it instead of it being silently discarded, as it was before this
        change (``publish_pending`` used to call this for its side effect only).
        """
        entry = event.to_eventbridge_entry(settings.event_bus_name)
        run_id = event.payload.get("run_id") if isinstance(event.payload, dict) else None
        log_extra: dict[str, Any] = {"detail_type": event.detail_type}
        if run_id is not None:
            log_extra["run_id"] = run_id

        try:
            response = self._client.put_events(Entries=[entry])
        except Exception as exc:
            logger.warning(
                "EventBridge publish skipped — the API call did not complete, so "
                "this event never reached the bus",
                extra={**log_extra, "error": str(exc)},
            )
            return PublishOutcome(
                accepted=False, error_code=type(exc).__name__, error_message=str(exc)
            )

        if response.get("FailedEntryCount", 0) > 0:
            failed_entry = response["Entries"][0]
            logger.error(
                "EventBridge publish failed — the entry was rejected, so this "
                "event never reached the bus",
                extra={**log_extra, "entries": response["Entries"]},
            )
            return PublishOutcome(
                accepted=False,
                error_code=failed_entry.get("ErrorCode"),
                error_message=failed_entry.get("ErrorMessage"),
            )

        event_id = response["Entries"][0].get("EventId")
        logger.info(
            "EventBridge publish accepted — the event reached the bus; whether a "
            "rule matched and a target executed it is not visible from here",
            extra={**log_extra, "event_id": event_id},
        )
        return PublishOutcome(accepted=True, event_id=event_id)
