"""Regression guard for issue #1808: PR #1781 (issue #1779) moved
``tracer = Tracer()`` in ``main.py`` to *after* every ``app.include_router()``
call, including the one that triggers ``build_domain_router()`` -- which
dynamically imports every ``api.domains.<name>`` package (ADR-0022). That is
exactly the point of the reorder (deferring ``Tracer()``'s eager
``aws_xray_sdk``/``botocore`` import past domain registration so it no longer
masks a domain's own import cost), but it has a real consequence #1781's own
test suite never exercised: a domain doing ``from ...main import tracer`` --
symmetric with the sanctioned ``from api.identity import set_identity_provider``
pattern ``domains/README.md`` documents right next to it -- crashes the whole
API Lambda's import at cold start, because ``api.main.tracer`` genuinely does
not exist yet at the moment a domain package is imported.

``test_main_tracer_import_order.py`` (the PR's own guard) only checks (1)
textual ordering of the assignment and (2) that ``aws_xray_sdk.core`` is not
yet imported when ``build_domain_router()`` runs. Neither imports a domain
package that references ``main.tracer``, so both stay green regardless of
whether a domain doing exactly that works or crashes.

This file exercises the real failure mode through real import machinery, in a
subprocess (like the existing probe -- ``aws_xray_sdk.core``/``api.main`` are
process-global caches other tests in this session have almost certainly
already populated, which would make either half of this untestable in-process):

1. **Fail-first, real crash**: a domain written exactly like #1808's own
   reproduction (``from ...main import tracer``) still fails to import --
   proving the regression is real and stays real; the fix does not paper over
   it by silently making the shared instance available early again (which
   would reopen #1779, re-masking the import cost).
2. **The crash is translated, not just detected**: `build_domain_router()`
   catches that specific `ImportError` and re-raises one naming the real cause
   and the fix, instead of Python's stock "partially initialized module" text
   -- so the failure mode is a designed, documented contract violation, not an
   accident nobody explained.
3. **The sanctioned alternative genuinely works and is equivalent**: a domain
   constructing its own ``Tracer()`` (``domains/README.md``'s "Tracing your
   own domain code" section) imports cleanly, and its provider is the *same
   object* as ``main.py``'s own ``tracer.provider`` -- proving the "construct
   your own" fix is not a different, second tracer, just a different
   `Tracer()` call resolving to the one true underlying provider
   ``aws_lambda_powertools`` caches process-wide.
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
_DISALLOWED_DOMAIN = """\
from ...main import tracer

routers = ()
"""

# domains/README.md's sanctioned "construct your own" pattern.
_SANCTIONED_DOMAIN = """\
from aws_lambda_powertools import Tracer

tracer = Tracer()
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

    try:
        import api.main as m
    except ImportError as err:
        print("IMPORT_ERROR")
        print(err.name)
        print(str(err))
    else:
        print("IMPORT_OK")
        import importlib

        domain_mod = importlib.import_module("api.domains.probedomain")
        domain_tracer = getattr(domain_mod, "tracer", None)
        same_provider = domain_tracer is not None and domain_tracer.provider is m.tracer.provider
        print(same_provider)
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


def test_domain_importing_shared_tracer_still_fails_to_import() -> None:
    """The regression #1808 reported: reproduced live, through real import
    machinery, not inferred from source text. If this ever starts passing
    without the translation asserted below, `main.tracer` has become
    available before domain registration again -- which re-arms issue #1779
    (the eager botocore import masking a domain's own cost)."""
    lines = _run_probe(_DISALLOWED_DOMAIN)
    assert lines[0] == "IMPORT_ERROR", (
        "a domain doing `from ...main import tracer` imported cleanly -- "
        f"expected it to fail. Probe output: {lines}"
    )


def test_the_failure_is_translated_into_an_actionable_message() -> None:
    """Not just "it still fails" -- `build_domain_router()` must recognise
    this exact shape and replace Python's generic partial-init text with one
    naming the real cause (#1779's deferred ordering) and the fix (construct
    your own `Tracer()`), pointing at domains/README.md. Guards against the
    translation silently stopping (e.g. a future refactor of the error
    message's wording drifting out of the `"tracer" in str(err)` match)."""
    lines = _run_probe(_DISALLOWED_DOMAIN)
    assert lines[0] == "IMPORT_ERROR"
    name, message = lines[1], lines[2]
    assert name == "api.main"
    assert "construct your own" in message.lower(), message
    assert "README.md" in message, message
    assert "1779" in message, message


def test_domain_constructing_its_own_tracer_works_and_shares_the_provider() -> None:
    """The sanctioned alternative: importable cleanly, and not a second,
    divergent tracer -- `aws_lambda_powertools` caches the provider as a class
    attribute, so main.py's own (later) `Tracer()` call reuses whatever the
    domain's (earlier) call already patched, rather than re-patching or
    diverging."""
    lines = _run_probe(_SANCTIONED_DOMAIN)
    assert lines[0] == "IMPORT_OK", f"expected the sanctioned pattern to import cleanly: {lines}"
    assert lines[1] == "True", (
        "the domain's own Tracer() and main.py's tracer do not share a "
        f"provider -- they are not the same underlying tracer. Probe output: {lines}"
    )
