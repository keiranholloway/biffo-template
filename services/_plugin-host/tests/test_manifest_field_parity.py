"""Parity: every ``manifest.<field>`` discover.py reads must be a real field on
``PluginManifest`` (biffo-template#1517).

Before this issue, the model that gated CI/install (``PluginManifest``) and the
model discovery actually read (raw ``dict.get()`` calls) were two different
things that could silently disagree — ``user_ingress``/``admin_ingress`` were
exactly that disagreement. Now that discovery goes through ``PluginManifest``
directly, the two cannot drift on their own; this test exists for the case that
matters more going forward: a *future* edit to ``discover.py`` that starts
reading a new attribute Pydantic doesn't reject at import time (it would AttributeError
at *runtime*, on whichever plugin happens to be discovered first, not at
review/CI time on the diff that introduced it).

The field set below is DERIVED from discover.py's own source via `ast`, not
hand-listed — a hand-listed set is a second copy of the truth (the exact class
this issue's own investigation names: `_extract_detail` written twice, five
manifest parsers disagreeing) and would silently stop being checked the moment
someone added a field here without also updating this list.
"""

from __future__ import annotations

import ast
import inspect

import plugin_host.discover as discover_module
from biffo_plugin_sdk.plugin import PluginManifest


def _manifest_fields_read_by_discover() -> set[str]:
    """Every top-level `manifest.<attr>` attribute access in discover.py's
    source — i.e. every field of `PluginManifest` the host actually reads.

    Deliberately only the immediate `manifest.X` access, not `manifest.X.Y`
    (e.g. `manifest.user_ingress.app`): the nested `.app`/`.required_group`
    belong to `UserIngress`/`AdminIngress`, not to `PluginManifest` itself, and
    parity is being asserted at the manifest level, one model at a time.
    """
    source = inspect.getsource(discover_module)
    tree = ast.parse(source)
    fields: set[str] = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "manifest"
        ):
            fields.add(node.attr)
    return fields


def test_every_field_discover_reads_is_declared_on_pluginmanifest() -> None:
    read_fields = _manifest_fields_read_by_discover()

    # If this is empty, the AST derivation broke (e.g. discover.py renamed its
    # local variable away from `manifest`) — that is a bug in THIS test, not
    # evidence the host reads nothing. Fail loudly rather than vacuously pass.
    assert read_fields, (
        "derived an empty field set from discover.py — the AST walk found no "
        "`manifest.<attr>` accesses; check discover.py's local variable is "
        "still named `manifest` before trusting a pass here"
    )

    declared_fields = set(PluginManifest.model_fields)
    undeclared = read_fields - declared_fields

    assert not undeclared, (
        f"discover.py reads manifest.{undeclared} but PluginManifest does not "
        "declare it. This is exactly the parity gap biffo-template#1517 closed "
        "(user_ingress/admin_ingress were readable by the raw-dict host and "
        "invisible to the validated model) — declare the field on "
        "PluginManifest before discover.py reads it, not after."
    )
