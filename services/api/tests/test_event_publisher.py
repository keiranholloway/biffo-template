"""EventPublisher.publish's outcome and logging (biffo-template#1017).

Before this, `publish` returned None and only logged on the failure paths — a
successful publish left no trace of its EventId, so "never published" and
"published and lost downstream" were indistinguishable from Core's side alone.
These tests pin: (1) a real success against moto carries an EventId and logs
one, correlated by run_id; (2) a rejected entry and (3) an unreachable
EventBridge both report accepted=False with a reason, not just a bare failure.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import boto3
import pytest
from api.events.base import BiffoEvent, EventPublisher, PublishOutcome
from moto import mock_aws


def _event(run_id: str | None = "run-1") -> BiffoEvent:
    payload: dict[str, Any] = {"agent": "demo-enricher"}
    if run_id is not None:
        payload["run_id"] = run_id
    return BiffoEvent(detail_type="agent.run.requested", payload=payload)


@mock_aws
def test_a_successful_publish_returns_and_logs_the_event_id():
    publisher = EventPublisher()
    # Same region EventPublisher's own client resolves to (boto3.client("events")
    # with no explicit region), whatever that is in this environment — a
    # hardcoded region here would silently diverge from it.
    boto3.client("events", region_name=publisher._client.meta.region_name).create_event_bus(
        Name="biffo-events"
    )

    with patch("api.events.base.logger") as mock_logger:
        outcome = publisher.publish(_event())

    assert outcome.accepted is True
    assert outcome.event_id  # moto assigns a real-shaped id
    assert outcome.error_code is None

    mock_logger.info.assert_called_once()
    extra = mock_logger.info.call_args.kwargs["extra"]
    assert extra["run_id"] == "run-1"
    assert extra["event_id"] == outcome.event_id
    assert extra["detail_type"] == "agent.run.requested"


@mock_aws
def test_a_publish_with_no_run_id_omits_the_correlator():
    # Most events (CRUD, demo.requested) carry no run_id — the field must not
    # appear as None/garbage for every other event type this publisher sends.
    publisher = EventPublisher()
    boto3.client("events", region_name=publisher._client.meta.region_name).create_event_bus(
        Name="biffo-events"
    )

    with patch("api.events.base.logger") as mock_logger:
        publisher.publish(_event(run_id=None))

    extra = mock_logger.info.call_args.kwargs["extra"]
    assert "run_id" not in extra


def test_a_rejected_entry_reports_accepted_false_with_the_error_code():
    publisher = EventPublisher()
    fake_response = {
        "FailedEntryCount": 1,
        "Entries": [{"ErrorCode": "ThrottlingException", "ErrorMessage": "Rate exceeded"}],
    }

    with (
        patch.object(publisher, "_client") as mock_client,
        patch("api.events.base.logger") as mock_logger,
    ):
        mock_client.put_events.return_value = fake_response

        outcome = publisher.publish(_event())

    assert outcome == PublishOutcome(
        accepted=False, error_code="ThrottlingException", error_message="Rate exceeded"
    )
    mock_logger.error.assert_called_once()
    extra = mock_logger.error.call_args.kwargs["extra"]
    assert extra["run_id"] == "run-1"


def test_an_unreachable_eventbridge_reports_accepted_false_and_does_not_raise():
    publisher = EventPublisher()

    with (
        patch.object(publisher, "_client") as mock_client,
        patch("api.events.base.logger") as mock_logger,
    ):
        mock_client.put_events.side_effect = RuntimeError("no route to host")

        outcome = publisher.publish(_event())

    assert outcome.accepted is False
    assert outcome.error_code == "RuntimeError"
    assert outcome.error_message == "no route to host"
    mock_logger.warning.assert_called_once()
    extra = mock_logger.warning.call_args.kwargs["extra"]
    assert extra["run_id"] == "run-1"


@pytest.mark.parametrize("run_id", ["run-1", None])
def test_publish_never_raises_regardless_of_outcome(run_id: str | None):
    # The API-request-must-still-succeed guarantee (base.py's own docstring)
    # applies whether or not the payload carries a run_id.
    publisher = EventPublisher()
    with patch.object(publisher, "_client") as mock_client:
        mock_client.put_events.side_effect = Exception("boom")
        outcome = publisher.publish(_event(run_id=run_id))
    assert outcome.accepted is False
