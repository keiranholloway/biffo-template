from pydantic import BaseModel

from ..models.plugin_route import RouteDefinition
from ..models.plugin_table import PluginTableDefinition


class InstalledPluginResponse(BaseModel):
    """A single installed plugin, as returned by GET /admin/plugins/available.

    Deliberately not a BiffoBaseSchema (no id/tenant_id/created_at/updated_at)
    — this describes an installed plugin's static manifest, not a tenant-owned
    database row.
    """

    name: str
    version: str
    description: str = ""
    tables: list[PluginTableDefinition] = []
    routes: list[RouteDefinition] = []
    has_admin_ingress: bool = False
