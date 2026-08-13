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
    #: The Cognito group `admin_ingress.required_group` names, or None when
    #: `has_admin_ingress` is False. The portal's plugin-nav-contract.ts uses
    #: this to hide a nav entry the caller cannot reach (issue #1555) — never
    #: a substitute for the shared plugin host's own gate (mount.py), only a
    #: reason to not advertise capability the caller doesn't have (#1104).
    admin_required_group: str | None = None
    #: The manifest's first `ui_components` `nav-link` entry's `label`, or
    #: None if it declares none / it's malformed. The `path` of that same
    #: entry is deliberately never surfaced here — see
    #: plugin_ui_components.py's module docstring for why.
    admin_nav_label: str | None = None
