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

**Parsing (biffo-template#1517).** This used to read each manifest with raw
``json.loads`` + ``.get()`` and no validation at all — malformed JSON, a missing
``name``, or an incomplete ``user_ingress``/``admin_ingress`` all failed the same
way, a silent ``continue``, indistinguishable in the logs from an ordinary
data/event-only plugin that simply has no host-mounted surface. Meanwhile the one
model that *did* validate manifests (``biffo_plugin_sdk.plugin.PluginManifest``,
gating CI and ``biffo plugin install``) didn't declare ``user_ingress`` or
``admin_ingress`` at all, so it validated nothing this module actually reads.
Discovery now goes through that same model (``_load_manifest_tolerant`` below),
so there is exactly one parser for a plugin manifest, not five that can disagree.

**Strictness split (see the module docstring's landmine discussion in the PR that
introduced this).** ``PluginManifest`` is ``extra="forbid"`` — appropriate where a
human is present to act on a rejection: CI, ``biffo plugin install``. This module
runs unattended, shared by every installed plugin, at Lambda cold start — a single
malformed manifest raising here would take down every plugin on the host, which is
a worse failure than the silent skip it replaces. So a manifest that fails
validation is skipped, not raised, but **loudly**: logged at ERROR, not dropped
without a trace the way the old ``continue`` branches were.

That skip is deliberately not all-or-nothing at the granularity of ``user_ingress``
versus ``admin_ingress``. Discovery used to require ``user_ingress`` outright,
which discarded an admin-only plugin at runtime even once the deploy had packaged
its code onto the host (fixed for the *complete-vs-absent* case in #1466). The
remaining latent instance: a *present but incomplete* ``user_ingress`` (declared,
missing ``app`` or ``required_group``) made the whole manifest fail validation,
discarding a perfectly valid, unrelated ``admin_ingress`` on the same plugin along
with it. ``_load_manifest_tolerant`` below salvages that case — a validation
failure confined entirely to ``user_ingress`` and/or ``admin_ingress`` drops just
those surfaces (logged) and revalidates the rest, rather than discarding the whole
plugin. Any other validation failure (bad JSON, missing name, an unknown top-level
key, a malformed table or route) is a genuinely broken manifest and skips the
plugin entirely — loudly.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

from biffo_plugin_sdk.plugin import PluginManifest
from pydantic import ValidationError

_LOGGER = logging.getLogger(__name__)

# The only two top-level fields a validation error is safe to drop and retry
# without: an incomplete/malformed declaration on one of these must not discard
# an otherwise-valid, unrelated surface on the same manifest. Anything else
# failing validation means the manifest itself is broken.
_SALVAGEABLE_FIELDS = frozenset({"user_ingress", "admin_ingress"})


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


def _load_manifest_tolerant(manifest_path: Path) -> PluginManifest | None:
    """Validate one manifest through ``PluginManifest``, salvaging a valid
    ``admin_ingress``/``user_ingress`` from beside a broken sibling rather than
    discarding the whole plugin (see the module docstring). Returns ``None``,
    having logged loudly, for anything genuinely broken.
    """
    try:
        raw = manifest_path.read_text()
    except OSError as exc:
        _LOGGER.error("Plugin manifest %s is unreadable, skipping: %s", manifest_path, exc)
        return None

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        _LOGGER.error("Plugin manifest %s is not valid JSON, skipping: %s", manifest_path, exc)
        return None

    if not isinstance(data, dict):
        _LOGGER.error("Plugin manifest %s is not a JSON object, skipping.", manifest_path)
        return None

    try:
        return PluginManifest(**data)
    except ValidationError as exc:
        error_fields = {str(e["loc"][0]) for e in exc.errors() if e["loc"]}
        if not error_fields <= _SALVAGEABLE_FIELDS:
            _LOGGER.error("Plugin manifest %s failed validation, skipping: %s", manifest_path, exc)
            return None

        _LOGGER.error(
            "Plugin manifest %s declares a malformed %s; dropping just that "
            "surface and mounting the rest of the plugin rather than discarding "
            "it entirely: %s",
            manifest_path,
            "/".join(sorted(error_fields)),
            exc,
        )
        salvaged = {k: v for k, v in data.items() if k not in error_fields}
        try:
            return PluginManifest(**salvaged)
        except ValidationError as exc2:
            _LOGGER.error(
                "Plugin manifest %s still fails validation after dropping %s, skipping: %s",
                manifest_path,
                sorted(error_fields),
                exc2,
            )
            return None


def discover_plugins(services_root: str | Path) -> list[DiscoveredPlugin]:
    """Every user-facing or admin-facing plugin under ``services_root``, sorted by
    name. A directory without a ``biffo.plugin.json``, or whose manifest declares
    neither ``user_ingress`` nor ``admin_ingress``, is skipped (it is a data/event
    plugin, not a hosted one). A manifest that fails validation is skipped too —
    loudly logged, never silently — rather than raising and taking every other
    installed plugin down with it (see the module docstring).
    """
    root = Path(services_root)
    found: list[DiscoveredPlugin] = []
    if not root.is_dir():
        return found
    for entry in sorted(root.iterdir()):
        manifest_path = entry / "biffo.plugin.json"
        if not entry.is_dir() or not manifest_path.is_file():
            continue

        manifest = _load_manifest_tolerant(manifest_path)
        if manifest is None:
            continue

        if manifest.user_ingress is None and manifest.admin_ingress is None:
            continue  # data/event-only plugin — nothing for the host to mount

        declared = tuple(
            DeclaredRoute(method=route.method, path=route.path) for route in manifest.api_routes
        )

        found.append(
            DiscoveredPlugin(
                name=manifest.name,
                app_ref=manifest.user_ingress.app if manifest.user_ingress else None,
                required_group=(
                    manifest.user_ingress.required_group if manifest.user_ingress else None
                ),
                admin_app_ref=manifest.admin_ingress.app if manifest.admin_ingress else None,
                admin_required_group=(
                    manifest.admin_ingress.required_group if manifest.admin_ingress else None
                ),
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
