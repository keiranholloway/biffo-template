from typing import Any, Literal

from pydantic import BaseModel, Field


class EndpointResponse(BaseModel):
    """A single live API endpoint in the admin "Endpoints" listing.

    Assembled from the app's OpenAPI schema (so it reflects every mounted route,
    not just generic CRUD), enriched with generic-CRUD permission metadata where a
    route matches one — ``permission_editable`` is True only for those (they can
    be retuned via a PR, ADR-0008).

    ``source`` is OWNERSHIP: ``core`` (a route in ``services/api/`` — whether a
    hand-written router or the generic-CRUD layer) or ``plugin`` (mounted under
    ``/api/v1/plugins/<name>/``). It is not "how the route is produced": a
    hand-written core endpoint is still ``core``.
    """

    source: Literal["plugin", "core"]
    plugin: str | None = None  # plugin name, for source == "plugin"
    table: str | None = None  # for generic-CRUD rows
    operation: str | None = None  # list | read | create | update | delete
    method: str  # GET | POST | PUT | PATCH | DELETE
    path: str  # full path, e.g. /api/v1/plugins/notes/items or /api/v1/data/widgets
    summary: str | None = None  # OpenAPI operation summary
    tags: list[str] = Field(default_factory=list)
    # any-of; [] means any authenticated caller; None means unknown (a
    # hand-written route whose guard is a dependency, not surfaced in OpenAPI).
    required_role: list[str] | None = None
    permission_editable: bool = False  # True only for plugin generic-CRUD rows


class EndpointPermissionRequest(BaseModel):
    """Admin request to change one plugin table/operation's API permission (ADR-0008).

    v1 is plugin-only: ``plugin`` names the manifest at
    ``services/<plugin>/biffo.plugin.json``. This is not applied live — it is
    turned into a pull request by the isolated PR-signer.
    """

    plugin: str = Field(min_length=1)
    table: str = Field(min_length=1)
    operation: Literal["create", "read", "update", "delete", "list"]
    allowed: bool
    required_role: list[str] = Field(default_factory=list)


class EndpointPermissionResult(BaseModel):
    """The outcome of an accepted permission change: a PR was opened (not yet live)."""

    pr_url: str
    branch: str


# ── Endpoint "specifics" (the swagger-ish detail view) ──────────────────────
# Derived from the app's OpenAPI schema for one route: request/response shapes as
# flat field tables plus a synthesized example. Read-only for now; a "try it"
# console is a planned fast-follow that can layer onto this same model.


class ParamSpec(BaseModel):
    """A path/query/header parameter."""

    name: str
    location: str  # "path" | "query" | "header" | "cookie"
    type: str
    required: bool
    description: str | None = None


class SchemaField(BaseModel):
    """One property of a request/response object, flattened for display."""

    name: str
    type: str  # human label, e.g. "string", "array<string>", "string | null"
    required: bool
    description: str | None = None
    notes: str | None = None  # enum/format/constraints summary


class BodySpec(BaseModel):
    """A request body (its top-level object fields + an example)."""

    content_type: str
    fields: list[SchemaField] = Field(default_factory=list)
    example: Any | None = None


class ResponseSpec(BaseModel):
    """One documented response, keyed by status code."""

    status_code: str
    description: str | None = None
    content_type: str | None = None
    fields: list[SchemaField] = Field(default_factory=list)
    example: Any | None = None


class EndpointDetail(BaseModel):
    """The full specifics for one endpoint, for the expandable detail panel."""

    method: str
    path: str
    summary: str | None = None
    description: str | None = None
    parameters: list[ParamSpec] = Field(default_factory=list)
    request_body: BodySpec | None = None
    responses: list[ResponseSpec] = Field(default_factory=list)
