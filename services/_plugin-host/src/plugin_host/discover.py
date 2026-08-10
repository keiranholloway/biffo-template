"""Discovering the user-facing plugins the shared host should mount (ADR-0021).

A user-facing plugin is a vendored ``services/<name>/`` directory whose
``biffo.plugin.json`` declares a ``user_ingress``. Discovery reads those manifests
and returns what the host needs to mount each one: the plugin's name (its URL
segment and asserted identity, ADR-0021 §1a), its ASGI app reference, and the
Cognito group a caller must be in (ADR-0011).

The ASGI app is referenced as ``"<module>:<attr>"`` (e.g. ``"ideation.app:app"``)
in ``user_ingress.app`` — the host mounts that app, and provides the Lambda entry
itself, so a plugin no longer ships its own Mangum handler.

A plugin may additionally declare ``admin_ingress`` (same schema as ``user_ingress``)
to mount an authenticated, admin-gated API and static UI bundle alongside the user
ingress.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class DeclaredRoute:
    """One manifest-declared ``api_routes`` entry (ADR-0003).

    These are NOT served by the plugin's own app — Core generates handlers for
    them from the table declaration. The host only needs to recognise them so it
    can forward them to Core (#652); it never implements them.
    """

    method: str
    path: str


@dataclass(frozen=True)
class DiscoveredPlugin:
    name: str
    #: ``None`` when the plugin declares only ``admin_ingress``.
    app_ref: str | None  # "module:attr"
    required_group: str | None
    admin_app_ref: str | None = None  # "module:attr" or None if admin_ingress not declared
    admin_required_group: str | None = None  # Cognito group or None if admin_ingress not declared
    #: Manifest-declared api_routes, forwarded to Core rather than served here.
    api_routes: tuple[DeclaredRoute, ...] = ()


def discover_plugins(services_root: str | Path) -> list[DiscoveredPlugin]:
    """Every user-facing plugin under ``services_root``, sorted by name. A directory
    without a ``biffo.plugin.json``, or whose manifest has no ``user_ingress``, is
    skipped (it is a data/event plugin, not a hosted one)."""
    root = Path(services_root)
    found: list[DiscoveredPlugin] = []
    if not root.is_dir():
        return found
    for entry in sorted(root.iterdir()):
        manifest_path = entry / "biffo.plugin.json"
        if not entry.is_dir() or not manifest_path.is_file():
            continue
        try:
            manifest = json.loads(manifest_path.read_text())
        except (ValueError, OSError):
            continue
        # EITHER surface makes a plugin host-mounted. Requiring user_ingress
        # here discarded admin-only plugins at runtime even once the deploy had
        # packaged their code onto the host — the same filter, one layer down
        # from the packaging loop fixed in #1466.
        ingress = manifest.get("user_ingress")
        admin_ingress = manifest.get("admin_ingress")
        if not isinstance(ingress, dict) and not isinstance(admin_ingress, dict):
            continue
        name = manifest.get("name")
        app_ref = None
        required_group = None
        if isinstance(ingress, dict):
            app_ref = ingress.get("app")
            required_group = ingress.get("required_group")
            # A user_ingress that is declared but incomplete is a broken
            # declaration, not an admin-only plugin — skip as before.
            if not (app_ref and required_group):
                continue
        if not name:
            continue

        # Parse admin_ingress if present
        admin_app_ref = None
        admin_required_group = None
        if isinstance(admin_ingress, dict):
            admin_app_ref = admin_ingress.get("app")
            admin_required_group = admin_ingress.get("required_group")
            # Only populate if both are present
            if not (admin_app_ref and admin_required_group):
                admin_app_ref = None
                admin_required_group = None

        declared = tuple(
            DeclaredRoute(method=str(r["method"]).upper(), path=str(r["path"]))
            for r in manifest.get("api_routes") or []
            if isinstance(r, dict) and r.get("method") and r.get("path")
        )

        found.append(
            DiscoveredPlugin(
                name=name,
                app_ref=app_ref,
                required_group=required_group,
                admin_app_ref=admin_app_ref,
                admin_required_group=admin_required_group,
                api_routes=declared,
            )
        )
    return found


def load_app(app_ref: str) -> object:
    """Import and return the ASGI app named by ``"<module>:<attr>"``."""
    from importlib import import_module

    module_name, _, attr = app_ref.partition(":")
    if not module_name or not attr:
        raise ValueError(f"app reference {app_ref!r} must be '<module>:<attr>'")
    return getattr(import_module(module_name), attr)
