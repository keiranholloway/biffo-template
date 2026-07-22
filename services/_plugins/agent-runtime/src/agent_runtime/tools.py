"""The tool registry — a worker's ceiling on what it can do (ADR-0014 §7).

"Tools are not tables, and the registry is their ceiling… Tools are registered
functions in the framework — as orchestrator's actions already are — so adding
one is inherently a reviewed code change and needs no separate allowlist. A
worker **declares which registered tools it uses, defaulting to none**."

That is this module, and it follows the orchestrator's convention deliberately:
:data:`TOOL_REGISTRY` is a module-level dict keyed by name, exactly as
``orchestrator.actions.ACTION_HANDLERS`` is. Adding a capability is adding an
entry, in a PR, with a review — never an admin toggle and never a definition
field a worker author can widen.

## Two rules bind every tool in here. Read them before adding one.

**1. Tools are read-only.** A tool observes; it never changes anything. This is
§7's no-write stance reaching past Core tables to everything else: "writes are
not reachable through this path at all", and "a worker needing to write business
data is a new decision requiring an amendment to this ADR". Structurally, an
executor is handed *only* its parsed arguments — no Core client, no session, no
credentials — so reaching a write surface means building a client inside the
tool, which is exactly the visible change review should stop.

**2. No tool may take model-generated text and send it outward.** A "fetch this
URL" tool is an exfiltration channel wearing a helpful hat: the model writes the
address, so private context rides out in the query string, and the trifecta the
ADR's security model says is "bounded by construction" is unbounded again by one
convenient function. Web search is a low-bandwidth version of the same thing and
is the accepted exception — accepted because a search query is short, is what the
capability *is*, and cannot carry a document.

Rule 2 is **enforced, not documented**: :func:`register` refuses a tool whose
string parameters are unbounded or larger than :data:`MAX_OUTBOUND_CHARS`, and
refuses object/array parameters outright (a nested field is an unbounded field
with extra steps). :meth:`ToolDefinition.coerce_arguments` then truncates to the
declared bound before the executor ever runs, so the ceiling holds against a
model that ignores the schema as well as against a tool that declares a generous
one. A tool that genuinely needs to ship a document is a change to this contract
and should be argued for, not slipped past it.

## Two failures, deliberately unequal

- **A declared tool that is not registered fails the run, before any model
  call.** Silently dropping it is undiagnosable: the run looks like a model that
  chose not to call the tool, and the transcript agrees. It is a typo or a
  definition written against a different deployment's build, and both want to be
  loud.
- **A registered tool that is not configured is simply not offered.** A missing
  credential is an operational state, not a broken definition, so the run
  proceeds with one fewer capability rather than failing every time. The drop is
  logged, because the two outcomes must not look alike from the run record.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

from aws_lambda_powertools import Logger

from .search import (
    WEB_SEARCH_DESCRIPTION,
    WEB_SEARCH_NAME,
    WEB_SEARCH_PARAMETERS,
    execute_web_search,
    web_search_configured,
)

logger = Logger()

#: An executor takes the model's (coerced) arguments and returns text. Nothing
#: else is passed in — see rule 1.
ToolExecutor = Callable[[dict[str, Any]], Awaitable[str]]

#: The longest string a tool may accept from the model, per parameter. Rule 2's
#: enforcement point: a query fits, a document does not.
MAX_OUTBOUND_CHARS = 256

#: Parameter types a tool may declare. Scalars only — an object or array field is
#: an unbounded string field wearing a shape.
_ALLOWED_TYPES = frozenset({"string", "integer", "number", "boolean"})

_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class ToolError(Exception):
    """Base for everything this module raises."""


class ToolRegistrationError(ToolError):
    """A tool violates the registry contract. Raised at import, so it cannot ship."""


class UnknownToolError(ToolError):
    """A worker declared a tool this build does not register. Fails the run."""


class ToolArgumentError(ToolError):
    """The model called a tool with arguments the schema does not permit.

    Not terminal for the run: it comes back as a tool result the model can read
    and correct, the same way a provider error does.
    """


def _always_available() -> bool:
    return True


@dataclass(frozen=True)
class ToolDefinition:
    """One registered tool: its provider-facing contract plus its executor."""

    name: str
    description: str
    #: JSON Schema for the arguments, sent to the provider verbatim.
    parameters: dict[str, Any]
    execute: ToolExecutor
    #: Whether this deployment can actually run it (a credential, usually).
    #: Evaluated at resolve time, never cached — see the module docstring.
    is_available: Callable[[], bool] = field(default=_always_available)

    def to_provider_schema(self) -> dict[str, Any]:
        """The entry for the provider's ``tools`` array (OpenAI/OpenRouter shape)."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    def coerce_arguments(self, raw: Any) -> dict[str, Any]:
        """Validate and bound the model's arguments before the executor sees them.

        Three things happen, all of them the registry's job rather than each
        tool's: undeclared keys are dropped, required keys are enforced, and every
        string is truncated to the ``maxLength`` its schema declares. The last one
        is rule 2 holding at runtime — the schema is a request to the model, this
        is the bound.
        """
        if not isinstance(raw, dict):
            raise ToolArgumentError(f"{self.name} was called with non-object arguments.")

        properties = self.parameters.get("properties") or {}
        required = self.parameters.get("required") or []
        coerced: dict[str, Any] = {}
        for key, schema in properties.items():
            if key not in raw:
                continue
            coerced[key] = _coerce_value(self.name, key, schema, raw[key])

        missing = [key for key in required if key not in coerced]
        if missing:
            raise ToolArgumentError(f"{self.name} is missing required argument(s): {missing}.")
        return coerced


def _coerce_value(tool: str, key: str, schema: Any, value: Any) -> Any:
    declared = (schema or {}).get("type") if isinstance(schema, dict) else None
    if declared == "string":
        limit = int((schema or {}).get("maxLength") or MAX_OUTBOUND_CHARS)
        return str(value)[:limit]
    if declared == "boolean":
        return bool(value)
    if declared in {"integer", "number"}:
        try:
            return int(value) if declared == "integer" else float(value)
        except (TypeError, ValueError) as exc:
            raise ToolArgumentError(f"{tool}.{key} must be a {declared}.") from exc
    return value


def _validate(tool: ToolDefinition) -> None:
    """The registry contract, checked at import so a violation cannot deploy."""
    if not _NAME_PATTERN.match(tool.name):
        raise ToolRegistrationError(
            f"Tool name {tool.name!r} must be lowercase alphanumeric with underscores."
        )
    if not tool.description.strip():
        raise ToolRegistrationError(f"Tool {tool.name!r} has no description.")

    parameters = tool.parameters
    if not isinstance(parameters, dict) or parameters.get("type") != "object":
        raise ToolRegistrationError(f"Tool {tool.name!r} parameters must be a JSON Schema object.")

    properties = parameters.get("properties")
    if not isinstance(properties, dict):
        raise ToolRegistrationError(f"Tool {tool.name!r} declares no properties object.")

    for key, schema in properties.items():
        declared = schema.get("type") if isinstance(schema, dict) else None
        if declared not in _ALLOWED_TYPES:
            raise ToolRegistrationError(
                f"Tool {tool.name!r} parameter {key!r} has type {declared!r}; only "
                f"{sorted(_ALLOWED_TYPES)} are allowed — an object or array field is "
                "an unbounded outbound channel (registry rule 2)."
            )
        if declared != "string":
            continue
        limit = schema.get("maxLength")
        if not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0:
            raise ToolRegistrationError(
                f"Tool {tool.name!r} parameter {key!r} must declare a positive maxLength — "
                "no tool may take unbounded model-generated text outward (registry rule 2)."
            )
        if limit > MAX_OUTBOUND_CHARS:
            raise ToolRegistrationError(
                f"Tool {tool.name!r} parameter {key!r} declares maxLength {limit}, above the "
                f"registry ceiling of {MAX_OUTBOUND_CHARS} (registry rule 2)."
            )


def register(*tools: ToolDefinition) -> dict[str, ToolDefinition]:
    """Validate and index tools by name. Used to build :data:`TOOL_REGISTRY`."""
    registry: dict[str, ToolDefinition] = {}
    for tool in tools:
        _validate(tool)
        if tool.name in registry:
            raise ToolRegistrationError(f"Tool {tool.name!r} is registered twice.")
        registry[tool.name] = tool
    return registry


WEB_SEARCH = ToolDefinition(
    name=WEB_SEARCH_NAME,
    description=WEB_SEARCH_DESCRIPTION,
    parameters=WEB_SEARCH_PARAMETERS,
    execute=execute_web_search,
    is_available=web_search_configured,
)

#: tool name -> definition. A worker's ``tools`` list is looked up here and
#: nowhere else, which is what makes this the ceiling. Mirrors
#: ``orchestrator.actions.ACTION_HANDLERS``.
TOOL_REGISTRY: dict[str, ToolDefinition] = register(WEB_SEARCH)


def declared_tools(snapshot: dict[str, Any]) -> list[str]:
    """The tool names a run's definition snapshot declares — **defaulting to none**.

    §7's default-deny posture, read off the snapshot the run captured (§10) rather
    than off a live definition, so a run's tools are as reconstructible as its
    model and instructions.
    """
    raw = snapshot.get("tools")
    if raw is None or raw == "":
        return []
    # A single name is accepted as a bare string because an authoring form with
    # one text input is the obvious way this gets filled in; a comma-separated
    # list likewise. Neither widens anything — every name still has to resolve.
    items: Iterable[Any] = raw.split(",") if isinstance(raw, str) else raw
    if isinstance(items, (dict, bytes)):
        raise UnknownToolError(f"A worker's `tools` must be a list of names, got: {raw!r}")
    return [str(item).strip() for item in items if str(item).strip()]


def resolve_tools(names: Sequence[str]) -> list[ToolDefinition]:
    """Resolve declared names to definitions, or fail loudly.

    Called **before the first model call** (``plugin.py``), so an unregistered
    name costs nothing and is unambiguous. Registered-but-unavailable tools are
    dropped with a warning: see the module docstring for why those two cases are
    deliberately not the same failure.
    """
    unknown = [name for name in names if name not in TOOL_REGISTRY]
    if unknown:
        raise UnknownToolError(
            f"Worker declares unregistered tool(s) {sorted(unknown)}. "
            f"This build registers: {sorted(TOOL_REGISTRY)}."
        )

    resolved: list[ToolDefinition] = []
    seen: set[str] = set()
    for name in names:
        if name in seen:
            continue
        seen.add(name)
        tool = TOOL_REGISTRY[name]
        if not tool.is_available():
            logger.warning(
                "Declared tool is registered but not configured in this deployment; "
                "it will not be offered to the model",
                extra={"tool": name},
            )
            continue
        resolved.append(tool)
    return resolved
