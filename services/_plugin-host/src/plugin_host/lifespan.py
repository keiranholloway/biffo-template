"""Running mounted plugin apps' lifespans in the shared plugin host (#924).

**Starlette's ``Mount`` never delivers the ``lifespan`` scope to the app it
mounts.** A mounted FastAPI app serves requests perfectly while its
``@app.on_event("startup")`` / ``lifespan=`` handler never fires — which is why
nothing looked broken: the only missing thing was startup. Verified directly
against this repo's pinned Starlette (see ``tests/test_lifespan.py``).

That silently disabled every plugin's cold-start work. `services/api`'s
service-principal seed route (`internal_plugin_config.py`) exists specifically to
be called by a plugin's startup handler, so it was never called in production and
no plugin ever self-seeded.

So the host performs the handshake itself, per mounted app. Two properties are
load-bearing and neither is obvious:

**Once per process, not once per lifespan event.** Mangum runs its
``LifespanCycle`` *inside* ``Mangum.__call__`` (verified in mangum 0.21.0's
source), so the host's lifespan startup fires on **every Lambda invocation**, not
just cold starts. Without the latch in :class:`PluginLifespans`, every warm
request would re-run every plugin's startup — a Core round trip per request.

**Shutdown is deliberately never driven,** for the same reason: Mangum closes the
cycle at the *end* of each invocation, so driving shutdown would tear each plugin
down after its first request while the latch stopped startup from running again.
Lambda freezes the execution environment between invocations rather than stopping
it, so a plugin has nothing to clean up in between.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Sequence
from typing import Any

_LOGGER = logging.getLogger(__name__)

#: The ASGI lifespan connection scope, per the ASGI 3.0 spec. ``state`` is the
#: lifespan-state mapping apps may populate; each app gets its own.
_SPEC = {"type": "lifespan", "asgi": {"version": "3.0", "spec_version": "2.0"}}

#: Put on the reply queue when the app returned from the lifespan scope without
#: ever sending ``lifespan.startup.complete`` — i.e. it does not implement the
#: protocol. Distinct from an exception, which means the same thing.
_NO_LIFESPAN = object()


class PluginStartupError(Exception):
    """A mounted plugin's lifespan startup failed.

    Quarantines that one plugin (see :func:`plugin_host.mount.build_host`); it is
    never allowed to fail the whole host, which would take every *other* plugin
    in the shared Lambda down with it.
    """


class SubAppLifespan:
    """Drives ONE mounted ASGI app through the lifespan *startup* handshake.

    Framework-agnostic: it speaks raw ASGI, so it works for a FastAPI app, a bare
    Starlette app, or any conforming callable, rather than reaching into
    Starlette's ``Router.lifespan_context``.

    The driving task is kept alive after startup completes — a conforming app does
    not return from the lifespan scope until it is shut down, and its startup
    state (clients, pools, seeded flags) lives inside that call.
    """

    def __init__(self, label: str, app: Any) -> None:
        self.label = label
        self._app = app
        self._events: asyncio.Queue[dict] = asyncio.Queue()
        self._replies: asyncio.Queue[Any] = asyncio.Queue()
        self._task: asyncio.Task[None] | None = None

    async def _receive(self) -> dict:
        return await self._events.get()

    async def _send(self, message: dict) -> None:
        await self._replies.put(message)

    async def _run(self) -> None:
        try:
            await self._app({**_SPEC, "state": {}}, self._receive, self._send)
        except BaseException as exc:  # noqa: BLE001 — reported to the awaiter below
            await self._replies.put(exc)
        else:
            # A conforming app blocks until shutdown, so returning here means it
            # ignored the lifespan scope entirely.
            await self._replies.put(_NO_LIFESPAN)

    async def start(self) -> None:
        """Run the app's startup handler to completion.

        Returns quietly when the app does not implement lifespan at all (nothing
        to run). Raises :class:`PluginStartupError` when it implements lifespan
        and that startup failed.
        """
        self._task = asyncio.ensure_future(self._run())
        await self._events.put({"type": "lifespan.startup"})
        reply = await self._replies.get()

        if reply is _NO_LIFESPAN or isinstance(reply, BaseException):
            # Not an error: plenty of valid ASGI apps have no lifespan handler.
            _LOGGER.debug("Plugin %s does not implement the ASGI lifespan protocol.", self.label)
            return
        kind = reply.get("type")
        if kind == "lifespan.startup.complete":
            _LOGGER.info("Plugin %s startup complete.", self.label)
            return
        if kind == "lifespan.startup.failed":
            raise PluginStartupError(reply.get("message") or "startup failed")
        raise PluginStartupError(f"unexpected lifespan message {kind!r}")

    async def aclose(self) -> None:
        """Complete the handshake by shutting the app down and awaiting its task.

        **Not called by the host** (see this module's docstring — Mangum would fire
        it after every single invocation). It exists so a non-Lambda embedding, and
        this package's own tests, can release the suspended lifespan task instead of
        leaving it pending when the event loop closes.
        """
        if self._task is None:
            return
        await self._events.put({"type": "lifespan.shutdown"})
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await asyncio.wait_for(self._task, timeout=5)
        self._task = None


def startup_targets(
    mounted: Sequence[tuple[str, Any]],
) -> list[tuple[tuple[str, ...], Any]]:
    """Group ``(label, app)`` mounts into one entry per distinct app object.

    A plugin whose ``admin_ingress`` names the *same* app object as its
    ``user_ingress`` is mounted twice but must run startup **once** — while still
    being quarantined under *both* mount labels if that startup fails.
    """
    order: list[int] = []
    grouped: dict[int, tuple[list[str], Any]] = {}
    for label, app in mounted:
        if app is None:
            continue
        key = id(app)
        if key not in grouped:
            grouped[key] = ([], app)
            order.append(key)
        grouped[key][0].append(label)
    return [(tuple(grouped[k][0]), grouped[k][1]) for k in order]


class PluginLifespans:
    """Every mounted plugin app's lifespan startup, run exactly once per process.

    ``failures`` maps a mount label (``"<name>"`` or ``"<name>/admin"``) to why
    that plugin's startup failed. It is populated **in place**, so a caller that
    supplies the dict — the mount gate, which is built before startup runs — reads
    it live and can 503 that one plugin's routes.
    """

    def __init__(
        self,
        mounted: Sequence[tuple[str, Any]],
        *,
        failures: dict[str, str] | None = None,
    ) -> None:
        self._targets = startup_targets(mounted)
        self.failures: dict[str, str] = {} if failures is None else failures
        self._runners: list[SubAppLifespan] = []
        self._started = False

    async def startup(self) -> None:
        """Run each plugin's startup, at most once for the life of this process.

        A plugin that fails is recorded in :attr:`failures` and logged at ERROR;
        the remaining plugins still start. This is **not** "tolerate and
        continue": the failing plugin is then hard-failed (503) at its own mount
        rather than serving a half-initialised app, so the failure surfaces
        immediately and attributably instead of on a founder's first run
        (biffo-template#909, criterion 5). Failing the whole host instead would
        mean one plugin's transient boot error blacks out every other plugin in
        the shared Lambda, on every invocation, until someone redeploys.
        """
        if self._started:
            return
        self._started = True
        for labels, app in self._targets:
            runner = SubAppLifespan(labels[0], app)
            try:
                await runner.start()
            except PluginStartupError as exc:
                _LOGGER.exception("Plugin %s failed to start; quarantining it.", labels[0])
                for label in labels:
                    self.failures[label] = str(exc)
            else:
                self._runners.append(runner)

    async def aclose(self) -> None:
        """Release every started plugin's suspended lifespan task.

        **Never called from the host's lifespan** — see this module's docstring. For
        non-Lambda embeddings and tests only.
        """
        for runner in self._runners:
            await runner.aclose()
        self._runners.clear()
