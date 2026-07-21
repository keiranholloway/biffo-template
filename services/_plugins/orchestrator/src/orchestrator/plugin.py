"""OrchestratorPlugin — the engine's BiffoPluginBase implementation.

On a subscribed event it: (1) posts the event to the Core internal API, which
matches enabled workflow definitions and idempotently claims one run each;
(2) executes the action for every *newly claimed* run (skipping replays);
(3) records each outcome back to Core.

State lives in Core (ADR-0002); this plugin holds none. It reaches Core over the
IAM-signed internal API (ADR-0009) via ``SignedCoreClient``.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import os
from typing import Any

import boto3
import httpx
from aws_lambda_powertools import Logger
from biffo_plugin_sdk import (
    BiffoAPIClient,
    BiffoEvent,
    BiffoPluginBase,
    SignedCoreClient,
    load_manifest,
)

from .actions import ACTION_HANDLERS, WhatsAppSettings
from .manifest import MANIFEST_PATH

logger = Logger()

_INTERNAL_BASE = "/api/v1/internal/orchestration"
# Payload keys, in preference order, used as the event's idempotency key.
_ID_KEYS = ("demo_request_id", "id", "lead_id")


def _idempotency_key(event: BiffoEvent) -> str:
    """A stable key identifying this event, so a replay claims the same runs.

    Prefers an explicit id in the payload; falls back to a content hash so an
    event with no obvious id is still deduplicated against its own replays.
    """
    payload = event.payload
    for key in _ID_KEYS:
        value = payload.get(key)
        if value:
            return str(value)
    digest = hashlib.sha256(
        json.dumps({"d": event.detail_type, "p": payload}, sort_keys=True, default=str).encode()
    ).hexdigest()
    return f"{event.detail_type}:{digest}"


class OrchestratorPlugin(BiffoPluginBase):
    """Event-driven orchestration engine (ADR-0003 plugin)."""

    def __init__(
        self,
        api: BiffoAPIClient | None = None,
        ses_client: Any | None = None,
        http_client: Any | None = None,
        whatsapp: WhatsAppSettings | None = None,
    ) -> None:
        manifest = load_manifest(MANIFEST_PATH)
        super().__init__(manifest, api=api if api is not None else SignedCoreClient())
        self._ses = ses_client if ses_client is not None else boto3.client("ses")
        # Plain (unsigned) HTTP client for webhook actions — distinct from the
        # IAM-signed Core client. Reused across warm invocations to pool connections.
        self._http = http_client if http_client is not None else httpx.Client(timeout=10)
        # Account-level WhatsApp credentials come from the orchestrator's env, never
        # from a workflow's action_config (which is stored in the DB).
        self._whatsapp = whatsapp or WhatsAppSettings(
            access_token=os.environ.get("WHATSAPP_ACCESS_TOKEN", ""),
            phone_number_id=os.environ.get("WHATSAPP_PHONE_NUMBER_ID", ""),
            api_version=os.environ.get("WHATSAPP_API_VERSION", "v22.0"),
        )

        # Generic forwarder: react to *every* event and let Core decide what to
        # do (match it against enabled workflow definitions). Adding a new trigger
        # is then just a workflow definition — no plugin code change, no per-event
        # subscription to keep in sync (ADR-0010, epic #210). The broad EventBridge
        # rule is what delivers all events to this Lambda (#214).
        @self.subscribe_all()
        async def _forward(event: BiffoEvent) -> None:
            await self.process_event(event)

    def on_install(self) -> None:
        """No-op: workflow definitions are seeded out-of-band (DDL import), not
        via an API this plugin owns — orchestration tables are Core-owned and not
        exposed as generic CRUD."""
        return None

    def on_uninstall(self) -> None:
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
            await self._execute_run(run, event)

    async def _execute_run(self, run: dict[str, Any], event: BiffoEvent) -> None:
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

        try:
            result = handler(
                config,
                event.payload,
                ses_client=self._ses,
                http_client=self._http,
                core_client=self.api,
                whatsapp=self._whatsapp,
            )
            # Handlers whose side effect is an await-only call (the agent action
            # POSTs to Core through the async signed client) are `async def`.
            # Awaiting here rather than in every handler keeps registration and
            # the sync handlers unchanged.
            if inspect.isawaitable(result):
                result = await result
        except Exception as exc:  # noqa: BLE001 — any dispatch failure is recorded, not raised
            logger.exception("Action dispatch failed", extra={"run_id": run_id})
            await self._record(run_id, action_type, "failed", request=config, error=str(exc))
            return

        await self._record(run_id, action_type, "succeeded", request=config, response=result)

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
