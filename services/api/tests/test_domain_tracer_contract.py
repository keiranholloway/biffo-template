"""Regression guard for issue #1808: PR #1781 (issue #1779) moved
``tracer = Tracer()`` in ``main.py`` to *after* every ``app.include_router()``
call, including the one that triggers ``build_domain_router()`` -- which
dynamically imports every ``api.domains.<name>`` package (ADR-0022). That is
exactly the point of the reorder (deferring ``Tracer()``'s eager
``aws_xray_sdk``/``botocore`` import past domain registration so it no longer
masks a domain's own import cost), but it had a real consequence #1781's own
test suite never exercised: a domain doing ``from ...main import tracer`` --
symmetric with the sanctioned ``from api.identity import set_identity_provider``
pattern ``domains/README.md`` documents right next to it -- crashed the whole
API Lambda's import at cold start, because ``api.main.tracer`` did not exist
yet at the moment a domain package was imported.

``test_main_tracer_import_order.py`` (the PR's own guard) only checks (1)
textual ordering of the assignment and (2) that ``aws_xray_sdk.core`` is not
yet imported when ``build_domain_router()`` runs. Neither imports a domain
package that references ``main.tracer``, so both stayed green regardless of
whether a domain doing exactly that worked or crashed.

The fix: ``main.py`` resolves ``tracer`` lazily via a module-level
``__getattr__`` (PEP 562). A lookup that happens before the real
``tracer = _get_tracer()`` assignment at the bottom of the module -- which is
exactly what a domain's ``from ...main import tracer`` triggers, since
``build_domain_router()`` imports domain packages earlier in ``main.py``'s own
top-to-bottom execution -- constructs the one real ``Tracer()`` for the
process right there, memoized, so every later reference (including
``main.py``'s own bottom-of-file assignment) resolves to the *same object*.
Deferral is preserved for the common case (no domain reaches for ``tracer`` at
all): nothing constructs it until ``main.py``'s own assignment runs, after
every ``app.include_router()`` call.

This file exercises the real failure mode through real import machinery, in a
subprocess (like the existing probe -- ``aws_xray_sdk.core``/``api.main`` are
process-global caches other tests in this session have almost certainly
already populated, which would make either half of this untestable in-process):

1. **The regression is fixed, through real import machinery**: a domain
   written exactly like #1808's own reproduction (``from ...main import
   tracer``) imports cleanly, and its ``tracer`` is *identical* (``is``, not
   just "same provider") to ``main.py``'s own -- proving this is the one true
   shared tracer, not a lookalike.
2. **The deferral #1779 fixed is not re-armed**: a domain that never
   references ``tracer`` at all still does not pre-import
   ``aws_xray_sdk.core`` before ``build_domain_router()`` runs (mirrors
   ``test_main_tracer_import_order.py``'s own probe, through this file's
   sanctioned-alternative fixture).
3. **The sanctioned alternative still works and is equivalent**: a domain
   constructing its own ``Tracer()`` (rather than importing the shared one)
   still imports cleanly, and its provider is the *same* underlying object as
   ``main.py``'s ``tracer.provider`` -- proving that pattern is not a second,
   divergent tracer either.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

_SRC = Path(__file__).resolve().parents[1] / "src"

# Written with the real relative-import shape a domain author reaches for --
# identical in kind to #1808's own reproduction and to domains/README.md's
# `from api.identity import set_identity_provider` example one section up.
_SHARED_TRACER_DOMAIN = """\
from ...main import tracer

routers = ()
"""

# domains/README.md's alternative "construct your own" pattern -- still
# supported, still resolves to the same underlying provider.
_OWN_TRACER_DOMAIN = """\
from aws_lambda_powertools import Tracer

tracer = Tracer()
routers = ()
"""

# A domain that never references tracer at all, used to prove #1779's
# deferral still holds when nothing asks for it.
_NO_TRACER_DOMAIN = """\
routers = ()
"""

_PROBE = textwrap.dedent(
    """
    import sys
    from pathlib import Path

    sys.path.insert(0, {src!r})

    import api.domains as domains_pkg
    import api.routing.domain_router as domain_router

    tmp_domains = Path({tmp_domains!r})
    domain_router._DOMAINS_DIR = tmp_domains
    domains_pkg.__path__ = [*domains_pkg.__path__, str(tmp_domains)]

    state = {{}}
    _original_build_domain_router = domain_router.build_domain_router


    def _wrapped():
        state["xray_before_domain_router"] = "aws_xray_sdk.core" in sys.modules
        return _original_build_domain_router()


    domain_router.build_domain_router = _wrapped

    try:
        import api.main as m
    except ImportError as err:
        print("IMPORT_ERROR")
        print(err.name)
        print(str(err))
    else:
        print("IMPORT_OK")
        print(state.get("xray_before_domain_router"))
        import importlib

        domain_mod = importlib.import_module("api.domains.probedomain")
        domain_tracer = getattr(domain_mod, "tracer", None)
        print(domain_tracer is not None and domain_tracer is m.tracer)
        print(domain_tracer is not None and domain_tracer.provider is m.tracer.provider)
    """
)


def _run_probe(domain_source: str) -> list[str]:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        package = tmp_path / "probedomain"
        package.mkdir()
        (package / "__init__.py").write_text(domain_source, encoding="utf-8")

        script = _PROBE.format(src=str(_SRC), tmp_domains=str(tmp_path))
        result = subprocess.run(  # noqa: S603
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            check=False,
        )
    assert result.returncode == 0, (
        f"probe subprocess crashed instead of reporting a result:\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )
    # `build_domain_router()` logs a structured (JSON) INFO line for every
    # domain it registers -- filter those out rather than assume our own
    # `print()` markers land on any particular line number relative to them.
    lines = [
        line
        for line in result.stdout.splitlines()
        if line.strip() and not line.lstrip().startswith("{")
    ]
    assert lines, f"probe printed nothing; stderr:\n{result.stderr}"
    return lines


def test_domain_importing_shared_tracer_now_imports_cleanly() -> None:
    """The regression #1808 reported, reproduced live through real import
    machinery: a domain doing `from ...main import tracer` must import
    without raising. If this ever starts failing again, the #1779 reorder has
    regressed back to breaking the ADR-0022 domain-extension seam."""
    lines = _run_probe(_SHARED_TRACER_DOMAIN)
    assert lines[0] == "IMPORT_OK", (
        "a domain doing `from ...main import tracer` failed to import -- "
        f"expected it to succeed. Probe output: {lines}"
    )


def test_domain_importing_shared_tracer_gets_the_identical_object() -> None:
    """Not just "importable" -- the domain's `tracer` must be `main.py`'s own
    `tracer`, the exact same object, proving there is one true shared tracer
    rather than a lookalike constructed separately."""
    lines = _run_probe(_SHARED_TRACER_DOMAIN)
    assert lines[0] == "IMPORT_OK"
    same_object = lines[2]
    assert same_object == "True", (
        f"the domain's `tracer` is not identical to `main.py`'s own. Probe output: {lines}"
    )


def test_domain_referencing_tracer_still_defers_xray_past_domain_router_entry() -> None:
    """#1779's deferral, exercised the way this specific trigger works: even
    though a domain importing `tracer` constructs the real `Tracer()` earlier
    than `main.py`'s own bottom-of-file assignment, `aws_xray_sdk.core` must
    not be resident in `sys.modules` *before* `build_domain_router()` is
    called -- construction happens inside that call (while importing the
    domain), not before it, so nothing upstream of domain registration pays
    for it."""
    lines = _run_probe(_SHARED_TRACER_DOMAIN)
    assert lines[0] == "IMPORT_OK"
    xray_before_domain_router = lines[1]
    assert xray_before_domain_router == "False", (
        "aws_xray_sdk.core was already imported before build_domain_router() was even "
        f"called -- issue #1779 has regressed. Probe output: {lines}"
    )


def test_domain_not_referencing_tracer_never_pre_imports_xray() -> None:
    """A domain that does not touch `tracer` at all must not trigger its
    construction either -- the lazy resolution must not become eager by
    accident."""
    lines = _run_probe(_NO_TRACER_DOMAIN)
    assert lines[0] == "IMPORT_OK"
    xray_before_domain_router = lines[1]
    assert xray_before_domain_router == "False", (
        f"aws_xray_sdk.core was imported even though no domain referenced tracer. "
        f"Probe output: {lines}"
    )


def test_domain_constructing_its_own_tracer_still_works_and_shares_the_provider() -> None:
    """The alternative pattern documented in domains/README.md: importable
    cleanly, and not a second, divergent tracer -- `aws_lambda_powertools`
    caches the provider as a class attribute, so main.py's own (later)
    `Tracer()` call reuses whatever the domain's (earlier) call already
    patched, rather than re-patching or diverging."""
    lines = _run_probe(_OWN_TRACER_DOMAIN)
    assert lines[0] == "IMPORT_OK", f"expected the alternative pattern to import cleanly: {lines}"
    same_provider = lines[3]
    assert same_provider == "True", (
        "the domain's own Tracer() and main.py's tracer do not share a "
        f"provider -- they are not the same underlying tracer. Probe output: {lines}"
    )
