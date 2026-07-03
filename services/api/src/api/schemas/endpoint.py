from typing import Literal

from pydantic import BaseModel, Field


class EndpointResponse(BaseModel):
    """A single live generic-CRUD endpoint and the role required to call it.

    Assembled from what the plugin and core-table routers actually mount, so it
    reflects the live surface, not just what a manifest declares.
    """

    source: Literal["plugin", "core"]
    plugin: str | None = None  # plugin name, for source == "plugin"
    table: str
    operation: str  # list | read | create | update | delete
    method: str  # GET | POST | PUT | PATCH | DELETE
    path: str  # full path, e.g. /api/v1/plugins/rbac/roles or /api/v1/data/widgets
    required_role: list[str]  # any-of; [] means any authenticated caller


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
