"""Discovering the user-facing plugins the shared host should mount (ADR-0021).

A user-facing plugin is a vendored ``services/<name>/`` directory whose
``biffo.plugin.json`` declares a ``user_ingress``. Discovery reads those manifests
and returns what the host needs to mount each one: the plugin's name (its URL
segment and asserted identity, ADR-0021 §1a), its ASGI app reference, and the
Cognito group a caller must be in (ADR-0011).

The ASGI app is referenced as ``"<module>:<attr>"`` (e.g. ``"ideation.app:app"``)
in ``user_ingress.app`` — the host mounts that app, and provides the Lambda entry
itself, so a plugin no longer ships its own Mangum handler.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class DiscoveredPlugin:
    name: str
    app_ref: str  # "module:attr"
    required_group: str


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
        ingress = manifest.get("user_ingress")
        if not isinstance(ingress, dict):
            continue
        name = manifest.get("name")
        app_ref = ingress.get("app")
        required_group = ingress.get("required_group")
        if not (name and app_ref and required_group):
            continue
        found.append(DiscoveredPlugin(name=name, app_ref=app_ref, required_group=required_group))
    return found


def load_app(app_ref: str) -> object:
    """Import and return the ASGI app named by ``"<module>:<attr>"``."""
    from importlib import import_module

    module_name, _, attr = app_ref.partition(":")
    if not module_name or not attr:
        raise ValueError(f"app reference {app_ref!r} must be '<module>:<attr>'")
    return getattr(import_module(module_name), attr)
