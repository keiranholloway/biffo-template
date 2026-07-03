from typing import Literal

from pydantic import BaseModel


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
