"""Plugin manifest schema validation and registration helpers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel


class ColumnDef(BaseModel):
    """Definition of a single table column for plugin manifests."""

    name: str
    type: str
    nullable: bool = True
    default: Any = None
    primary_key: bool = False


class IndexDef(BaseModel):
    """Definition of a database index for plugin manifests."""

    columns: list[str]
    unique: bool = False


class RouteDef(BaseModel):
    """Definition of an API route for plugin manifests."""

    method: str
    path: str
    handler: str
    summary: str = ""
    description: str = ""


class PluginManifest(BaseModel):
    """Validated manifest for a Biffo plugin.

    Required fields: ``name``, ``version``.
    Optional fields carry sensible defaults so plugins can be minimal.
    """

    name: str
    version: str
    description: str = ""
    author: str = ""
    tags: list[str] = []
    tables: list[ColumnDef] = []
    api_routes: list[RouteDef] = []
    required_core_version: str = ">=0.0.0"

    def model_dump_serializable(self) -> dict[str, Any]:
        """Return a JSON-serialisable dict (no Pydantic internals)."""
        return self.model_dump(mode="json")


def load_manifest(path: str | Path) -> PluginManifest:
    """Load and validate a plugin manifest from a JSON file.

    Raises:
        FileNotFoundError: If *path* does not exist.
        ValueError: If the file contains invalid JSON or fails schema validation.
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Manifest not found: {p}")

    try:
        raw = p.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"Cannot read manifest: {exc}") from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in manifest {p}: {exc}") from exc

    try:
        return PluginManifest(**data)
    except Exception as exc:
        raise ValueError(f"Schema validation failed for {p}: {exc}") from exc


def register_plugin(manifest: PluginManifest) -> dict[str, Any]:
    """Return a serialisable registration dict for the given manifest.

    This is what the CLI sends to the registry during ``biffo plugin install``.
    """
    return {
        "name": manifest.name,
        "version": manifest.version,
        "description": manifest.description,
        "author": manifest.author,
        "tags": manifest.tags,
        "required_core_version": manifest.required_core_version,
        "tables": [t.model_dump(mode="json") for t in manifest.tables],
        "api_routes": [r.model_dump(mode="json") for r in manifest.api_routes],
    }
