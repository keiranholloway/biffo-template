import json
from typing import Any

import boto3
from aws_lambda_powertools import Logger
from pydantic import BaseModel, Field

from ..config import settings

logger = Logger()


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
        self._client = boto3.client("events", region_name=settings.aws_region)

    def publish(self, event: BiffoEvent) -> None:
        entry = event.to_eventbridge_entry(settings.event_bus_name)
        response = self._client.put_events(Entries=[entry])
        if response.get("FailedEntryCount", 0) > 0:
            logger.error("EventBridge publish failed", extra={"entries": response["Entries"]})
            raise RuntimeError("Failed to publish event to EventBridge")
