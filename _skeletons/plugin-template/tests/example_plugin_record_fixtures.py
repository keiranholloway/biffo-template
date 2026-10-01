"""Capture real payloads as this plugin's test fixtures (don't invent them).

A test can only check what its author already thought of, so a new plugin's
first fixtures come from the real system, not from a hand-written dict. Run,
against dev (never prod):

    BIFFO_CORE_URL=https://core.dev.example.com BIFFO_CORE_TOKEN=<jwt> \\
        uv run python tests/example_plugin_record_fixtures.py core_widgets_list \\
        /api/v1/plugins/example-plugin/widgets

It GETs the path and writes `tests/captured/<shape>.json`, which you commit.
Agent outputs are captured the same way from code: call
`FixtureRecorder("tests/captured", record=True).capture("<shape>", fetch)` where
`fetch` runs the real agent once. Tests then replay with
`FixtureRecorder(CAPTURED).load("<shape>")`; a missing shape raises rather than
silently inventing one. Requires biffo-plugin-sdk >= 1.8.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from biffo_plugin_sdk import BiffoAPIClient, FixtureRecorder

CAPTURED_DIR = Path(__file__).parent / "captured"


async def _main(shape: str, path: str) -> None:
    async with BiffoAPIClient(
        base_url=os.environ["BIFFO_CORE_URL"], token=os.environ["BIFFO_CORE_TOKEN"]
    ) as client:
        recorder = FixtureRecorder(CAPTURED_DIR, record=True)
        payload = await client.get(path)
        print(f"wrote {recorder.save(shape, payload)}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: example_plugin_record_fixtures.py <shape> <core-path>")
    asyncio.run(_main(sys.argv[1], sys.argv[2]))
