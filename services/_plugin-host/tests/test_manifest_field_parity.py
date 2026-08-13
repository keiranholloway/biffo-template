"""Parity: every manifest field the plugin host reads must be a real field on
``PluginManifest`` (biffo-template#1362 instance 9, #1517).

Before #1561, the model that gated CI/install (``PluginManifest``) and the model
discovery actually read (raw ``dict.get()`` calls) were two different things that
could silently disagree — ``user_ingress``/``admin_ingress`` were exactly that
disagreement. Now that discovery goes through ``PluginManifest`` directly, the
two cannot drift on their own; this test exists for the case that matters more
going forward: a *future* edit to the host that starts reading a field the model
does not declare.

The field set below is DERIVED from the host package's own source via ``ast``,
not hand-listed — a hand-listed set is a second copy of the truth (the exact
class this issue's investigation names) and would silently stop being checked
the moment someone added a field without also updating the list.

**What changed here, and why (#1362 instance 9, follow-up).** The first version
of this guard derived its field set from *one hardcoded module* (``discover.py``)
and *one hardcoded variable name* (``manifest``). That denominator was narrower
than the thing it claimed to check, and it was proven blind by execution: a
function reading ``mf.nav_entries`` where ``mf: PluginManifest``, and a second
host module reading ``manifest.nav_entries``, both **passed** this guard, while
the identical defect written as ``manifest.nav_entries`` inside ``discover.py``
failed it. That is #1363's shape living inside #1362's fix — a check that cannot
see an input reports the remainder as the whole. The denominator is now:

* **every module in the ``plugin_host`` package**, enumerated from the
  filesystem rather than named here, and
* **every local name bound to a ``PluginManifest``**, resolved from type
  information in the source (parameter annotations, annotated assignments,
  ``PluginManifest(...)`` construction, and assignment from a function whose
  return annotation is ``PluginManifest``) rather than from what the variable
  happens to be called.

The literal name ``manifest`` is still treated as a manifest binding on top of
that, deliberately: if the host ever regresses to raw ``json.loads`` and calls
``manifest.get("user_ingress")``, ``get`` is not a declared field and this guard
goes red — which is instance 9 itself, caught on the diff that reintroduces it.
"""

from __future__ import annotations

import ast
from pathlib import Path

import plugin_host
import plugin_host.discover as discover_module
from biffo_plugin_sdk.plugin import PluginManifest

#: The model whose fields the host is being held to. Named once so the AST
#: matching below and the assertion below cannot drift apart.
_MODEL_NAME = PluginManifest.__name__

#: Conservatively treated as a manifest binding regardless of type information,
#: so a regression to raw-dict parsing (``manifest.get(...)``) fails this guard
#: rather than quietly passing it — see the module docstring.
_ALWAYS_MANIFEST_NAMES = frozenset({"manifest"})


def _host_package_modules() -> list[Path]:
    """Every Python module in the installed ``plugin_host`` package.

    Enumerated from the package's own directory, so a module added later is in
    the denominator automatically. Hardcoding ``discover.py`` here is what made
    the first version of this guard blind to a second reader.
    """
    package_dir = Path(plugin_host.__file__).resolve().parent
    return sorted(p for p in package_dir.rglob("*.py") if p.name != "__init__.py")


def _annotation_mentions_model(node: ast.expr | None) -> bool:
    """Whether an annotation refers to ``PluginManifest`` anywhere inside it.

    Walks the whole annotation subtree so ``PluginManifest``,
    ``PluginManifest | None``, ``Optional[PluginManifest]``, and the stringised
    ``"PluginManifest"`` form all match — the guard should not depend on which
    spelling of "this is a manifest" an author happened to reach for.
    """
    if node is None:
        return False
    for child in ast.walk(node):
        if isinstance(child, ast.Name) and child.id == _MODEL_NAME:
            return True
        if isinstance(child, ast.Attribute) and child.attr == _MODEL_NAME:
            return True
        if isinstance(child, ast.Constant) and child.value == _MODEL_NAME:
            return True
    return False


def _functions_returning_a_manifest(tree: ast.AST) -> set[str]:
    """Names of functions in this module whose return annotation is a manifest.

    This is what lets ``manifest = _load_manifest_tolerant(path)`` be recognised
    as a manifest binding without relying on the variable's name.
    """
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and _annotation_mentions_model(
            node.returns
        ):
            names.add(node.name)
    return names


def _assigned_names(target: ast.expr) -> set[str]:
    """Plain ``Name`` targets of an assignment, including tuple unpacking."""
    if isinstance(target, ast.Name):
        return {target.id}
    if isinstance(target, ast.Tuple | ast.List):
        return {n for element in target.elts for n in _assigned_names(element)}
    return set()


def _manifest_bindings(tree: ast.AST) -> set[str]:
    """Every local name in this module that holds a ``PluginManifest``.

    Derived from type information in the source — parameter annotations,
    annotated assignments, direct construction, and assignment from a
    manifest-returning function — never from the variable's name.
    """
    manifest_returning = _functions_returning_a_manifest(tree)
    bindings: set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.arg) and _annotation_mentions_model(node.annotation):
            bindings.add(node.arg)
        elif isinstance(node, ast.AnnAssign) and _annotation_mentions_model(node.annotation):
            bindings |= _assigned_names(node.target)
        elif isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
            func = node.value.func
            called = (
                func.id
                if isinstance(func, ast.Name)
                else func.attr
                if isinstance(func, ast.Attribute)
                else None
            )
            if called == _MODEL_NAME or called in manifest_returning:
                for target in node.targets:
                    bindings |= _assigned_names(target)

    return bindings


def _fields_read_from(source: str, *, include_name_fallback: bool = True) -> set[str]:
    """Every top-level ``<manifest>.<attr>`` access in one module's source.

    Deliberately only the immediate access, not ``manifest.user_ingress.app``:
    the nested ``.app``/``.required_group`` belong to ``UserIngress``/
    ``AdminIngress``, not to ``PluginManifest`` itself, and parity is asserted
    at the manifest level, one model at a time.
    """
    tree = ast.parse(source)
    bindings = _manifest_bindings(tree)
    if include_name_fallback:
        bindings |= _ALWAYS_MANIFEST_NAMES

    fields: set[str] = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id in bindings
        ):
            fields.add(node.attr)
    return fields


def _manifest_fields_read_by_the_host() -> dict[str, set[str]]:
    """``{module stem: fields read}`` across the whole ``plugin_host`` package."""
    return {
        module.stem: _fields_read_from(module.read_text(encoding="utf-8"))
        for module in _host_package_modules()
    }


def test_the_derivation_covers_the_whole_host_package_not_one_file() -> None:
    """The denominator check.

    A guard that enumerates is only as good as what it enumerated. This asserts
    the walk found real modules and that ``discover.py`` — the reader this guard
    was written for — is among them, so the guard cannot pass by having quietly
    stopped looking at anything.
    """
    modules = _host_package_modules()
    assert modules, (
        "found no modules in the plugin_host package — the filesystem walk is "
        "broken, which would make every parity assertion below vacuous"
    )
    assert "discover" in {module.stem for module in modules}, (
        f"discover.py is not in the enumerated host package "
        f"({sorted(m.stem for m in modules)}) — it is the module that reads the "
        "manifest, so a denominator missing it cannot be trusted"
    )


def test_the_type_derivation_finds_discovers_manifest_binding_without_the_name() -> None:
    """The type-derived half must work on its own.

    ``_ALWAYS_MANIFEST_NAMES`` would keep this guard passing on ``discover.py``
    even if the type derivation rotted to a no-op, and the whole point of the
    rewrite is that a manifest bound to some *other* name is still checked. So
    assert the type-derived half, with the name fallback switched off, still
    sees what ``discover.py`` reads.
    """
    source = Path(discover_module.__file__).read_text(encoding="utf-8")
    typed_only = _fields_read_from(source, include_name_fallback=False)
    assert typed_only, (
        "the type derivation found no manifest binding in discover.py — it "
        "assigns `manifest = _load_manifest_tolerant(...)`, whose return "
        "annotation is `PluginManifest | None`, so an empty result means "
        "_manifest_bindings has stopped working and only the variable-name "
        "fallback is still guarding anything"
    )


def test_every_manifest_field_the_host_reads_is_declared_on_pluginmanifest() -> None:
    by_module = _manifest_fields_read_by_the_host()
    read_fields = set().union(*by_module.values()) if by_module else set()

    # If this is empty the derivation broke; fail loudly rather than vacuously
    # pass. (The two tests above localise *which* half broke.)
    assert read_fields, (
        "derived an empty field set from the plugin_host package — no manifest "
        "attribute access was found anywhere, which cannot be true while "
        "discover.py mounts plugins off the manifest"
    )

    declared_fields = set(PluginManifest.model_fields)
    offenders = {
        module: sorted(fields - declared_fields)
        for module, fields in by_module.items()
        if fields - declared_fields
    }

    assert not offenders, (
        f"the plugin host reads manifest fields {_MODEL_NAME} does not declare: "
        f"{offenders}. This is exactly the parity gap biffo-template#1362 "
        "instance 9 recorded — user_ingress/admin_ingress were readable by the "
        f"raw-dict host and invisible to the validated model. Declare the field "
        f"on {_MODEL_NAME} before the host reads it, not after. (If the name "
        "above is a dict method such as `get`, the host has regressed to raw "
        "json.loads parsing and is no longer using the validated model at all.)"
    )
