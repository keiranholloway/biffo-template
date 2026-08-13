"""Portal UI component declarations from a plugin manifest (issue #1555).

Mirrors ``_skeletons/registry/registry-schema.json``'s ``ui_components`` items
schema (an array of ``{type, label, path, icon?, requires_auth?}`` objects,
not the ``string[]`` several TypeScript call sites wrongly declared it as —
see that issue for the full history).

Only the ``nav-link`` type is consumed today, and only its ``label`` —
``routers/admin/plugins.py`` uses :func:`parse_admin_nav_label_from_manifest`
to populate ``InstalledPluginResponse.admin_nav_label``, which
``apps/portal/src/lib/plugin-nav-contract.ts`` renders in the admin nav. The
declaration's own ``path`` (e.g. ``"/admin/marketing"``) is deliberately
**never** surfaced to the portal: it resolves to nothing there (in
production it fell through to an unrelated public route), because the
surface it is meant to name is actually served by the shared plugin host at
``/api/v1/plugins/<name>/admin`` (``services/_plugin-host/src/plugin_host/
mount.py``). The portal derives that href from the plugin's ``name`` and
``has_admin_ingress`` instead of trusting the manifest's hand-written
string — the label is safe to trust, the path is not.

``page``, ``dashboard-widget``, ``modal`` and ``dialog`` entries validate
here (so a manifest declaring one still passes CI) but are not read by
anything — adding a consumer for one of those is a new manifest-to-portal
seam, not an extension of this one.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

UiComponentType = Literal["nav-link", "page", "dashboard-widget", "modal", "dialog"]


class UiComponentDefinition(BaseModel):
    """One entry of a manifest's ``ui_components`` array."""

    model_config = ConfigDict(extra="forbid")

    type: UiComponentType
    label: str
    path: str
    icon: str | None = None
    requires_auth: bool = True


def parse_ui_components_from_manifest(manifest: dict[str, Any]) -> list[UiComponentDefinition]:
    """Every ``ui_components`` entry, in manifest order. Empty if absent.

    Raises on a malformed entry (mirrors ``parse_plugin_routes_from_manifest``'s
    contract) — the caller decides how to fail soft; see
    :func:`parse_admin_nav_label_from_manifest` for the one real caller today.
    """
    raw = manifest.get("ui_components", [])
    return [UiComponentDefinition(**entry) for entry in raw]


def parse_admin_nav_label_from_manifest(manifest: dict[str, Any]) -> str | None:
    """The ``label`` of the manifest's first ``nav-link`` UI component.

    ``None`` if the manifest declares no ``nav-link`` entry, or if its label
    is blank after trimming. Never raises a bare ``ValueError`` itself, but
    Pydantic construction inside :func:`parse_ui_components_from_manifest`
    can — callers should catch that the same way
    ``routers/admin/plugins.py`` already does for route declarations, so one
    plugin's malformed ``ui_components`` degrades to "no nav label" rather
    than taking the whole installed-plugins listing down.
    """
    for component in parse_ui_components_from_manifest(manifest):
        if component.type == "nav-link":
            label = component.label.strip()
            return label if label != "" else None
    return None
