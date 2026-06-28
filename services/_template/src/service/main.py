"""
Biffo microservice template.

Rules (ADR-0002):
  - Never import psycopg2, asyncpg, SQLAlchemy, or any DB client.
  - Read/write data by calling the Core API via httpx (see api_client below).
  - React to state changes by subscribing to EventBridge events.
  - Publish state changes by calling the Core API, which publishes the events.
"""

import os

import httpx
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.typing import LambdaContext

logger = Logger()
tracer = Tracer()

CORE_API_URL = os.environ.get("BIFFO_CORE_API_URL", "")


def get_api_client() -> httpx.Client:
    return httpx.Client(
        base_url=CORE_API_URL,
        timeout=30.0,
        headers={"Content-Type": "application/json"},
    )


@logger.inject_lambda_context
@tracer.capture_lambda_handler
def handler(event: dict, context: LambdaContext) -> dict:
    logger.info("Received event", extra={"event": event})

    # EventBridge event shape:
    # event["source"]      — e.g. "biffo.core"
    # event["detail-type"] — e.g. "UserCreated"
    # event["detail"]["tenant_id"]
    # event["detail"]["payload"]

    return {"statusCode": 200}
