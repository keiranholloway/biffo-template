"""No module in this plugin's own package may re-derive an expression one of
its helpers already holds — for **every** such helper, enumerated from the
code itself rather than named here one at a time.

## The class this closes (biffo-template#1587)

A shared helper is introduced to fix a defect, adopted at some call sites and
not others, and the helper's existence makes everyone believe it is fixed. The
unconverted sites keep the bug, behind a closed issue, looking done. Measured
twice in `biffo-plugin-marketing`: `public_base_url_for` was adopted at
**1 call site of 3** (marketing#72 — the two missed sites 500'd both packs),
and an artefact-body parser was filed against **2** sites when the tree held
**7 across 6 files** (marketing#49, swept in marketing#111).

`biffo-plugin-marketing` and `biffo-plugin-ideation` each grew a copy of this
guard by hand, after the fact, once their own instance of the class had
already shipped. #1587 is that the skeleton — the thing every plugin repo is
actually born from — carried no such test, so a **third** plugin starts life
non-adopting by construction and repeats the same class a third time before
anyone notices. Shipping the sweep here, rather than as a pattern to remember
to copy, is the fix: it travels with the code it watches from commit one.

## Why this is parameterised rather than a copy of the reference

`biffo-plugin-marketing`'s copy of this file hardcodes `src / "marketing"` as
the package it sweeps. That literal cannot be copied into this skeleton: every
plugin scaffolded from it gets a *different* package name (`biffo plugin
create` rewrites `example_plugin` throughout the repo — see
`.scaffold-tokens.json` and `cli/src/lib/plugin-scaffold.ts`'s
`substitutions()`), so a hardcoded name here would be correct for zero
scaffolded repos. `_package_dir()` below finds the package by shape — the sole
directory under `src/` with an `__init__.py` — so it resolves correctly both
in this template (`example_plugin`) and in every plugin it produces, with
nothing to rename when the scaffold runs.

## What counts as a consolidation helper

A function whose entire body is ``return <expression>`` (a docstring is
allowed). That is the shape of every helper this class has produced in the
sibling plugins: one expression, held once, called from many places. The
expression becomes a **template** whose parameters are wildcards; any
expression elsewhere in the package that structurally unifies with it is a
call site that bypassed the helper.

Three shapes are excluded, each for a reason rather than to quieten the output
(mirrored from the marketing reference copy, where each was needed for real):

- **FastAPI dependency providers** (a parameter defaulting to ``Depends(...)``).
  A plugin adding an `api_ingress` app (ADR-0021) will typically declare these
  per-router on purpose, so `dependency_overrides` can replace them per app —
  consolidating them would break that.
- **Pure delegations** — a lone call whose every argument is a bare parameter
  (``return await self._load_owned(owner_sub=owner_sub, ...)``). A façade like
  that holds no expression, so every ordinary call to the underlying function
  would be reported as bypassing it.
- **Expressions below `_MIN_TEMPLATE_NODES`.** ``return value or {}`` matches
  half of any package and means nothing.

## What this plugin's package sweeps to today, and why that is correct

At the time this file was added, this skeleton's own `example_plugin` package
holds **zero** consolidation-helper-shaped functions — `on_install()` and
`on_uninstall()` (**not invoked** by anything, biffo-template#709) are no-ops
returning a bare `None`, which is far below `_MIN_TEMPLATE_NODES`. That is the
right starting state, not a gap: a fresh
plugin has not yet had the chance to duplicate anything. The guard exists so
that when the first real helper — and later, the first hand-copy of its
expression — is written, this file catches it without anyone having to add a
new test for it. `test_the_swept_package_points_at_real_source` and
`test_the_guard_can_actually_fail` below exist precisely so a zero here is
never mistaken for "the collector is broken" (an empty denominator passing
for the wrong reason is the failure this whole class is about).

## Waivers are a ledger, not a mute button

A real duplicate that should *not* be consolidated goes in `_ACCEPTED_DUPLICATES`
with the reason, so it is one review-visible line rather than a silently
tolerated copy — and `test_no_accepted_duplicate_has_gone_stale` deletes the
excuse when the code moves on.
"""

from __future__ import annotations

import ast
from pathlib import Path

# --------------------------------------------------------------------------
# Subject: this plugin's own package, located by shape rather than by name —
# see the module docstring's "Why this is parameterised" section.
# --------------------------------------------------------------------------

_PLUGIN_ROOT = Path(__file__).resolve().parents[1]
_SRC_ROOT = _PLUGIN_ROOT / "src"


def _package_dir() -> Path:
    """The plugin's own package directory, found by shape rather than by name.

    `src/` holds exactly one package directory in this template and in every
    plugin scaffolded from it (`packages = ["src/<name>"]` in `pyproject.toml`
    is single-valued too), so locating the sole directory with an
    `__init__.py` works everywhere a literal package name would not.
    """
    candidates = sorted(
        p for p in _SRC_ROOT.iterdir() if p.is_dir() and (p / "__init__.py").is_file()
    )
    assert len(candidates) == 1, (
        f"expected exactly one package under {_SRC_ROOT}, found "
        f"{[c.name for c in candidates]} — the sweep cannot tell which one is "
        "this plugin's own source."
    )
    return candidates[0]


_SRC = _package_dir()

#: Below this many AST nodes an expression is too common to mean anything.
#: Matches the marketing reference copy's threshold: it admits real duplicated
#: expressions (a ternary, an `HTTPException(...)` call) while still rejecting
#: `raw or {}` (4 nodes) — see `test_a_near_miss_is_not_reported` below for a
#: fixture at exactly that shape.
_MIN_TEMPLATE_NODES = 8

#: (helper name, file that re-derives it) -> why that copy is correct.
#: Empty today: this skeleton ships with no known-correct duplicate. A real
#: plugin built from it adds entries here as it earns them, same as the
#: marketing and ideation copies did.
_ACCEPTED_DUPLICATES: dict[tuple[str, str], str] = {}


# --------------------------------------------------------------------------
# Finding the helpers
# --------------------------------------------------------------------------


def _parameter_names(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    """Every name bound by the signature — the template's wildcards."""
    args = fn.args
    names = {a.arg for a in [*args.posonlyargs, *args.args, *args.kwonlyargs]}
    if args.vararg:
        names.add(args.vararg.arg)
    if args.kwarg:
        names.add(args.kwarg.arg)
    return names


def _sole_returned_expression(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> ast.expr | None:
    """The expression of a body that is exactly ``return <expr>``, or `None`.

    A leading docstring is skipped, because helpers in this plugin's style
    tend to have one and requiring a bare body would exclude them.
    """
    body = list(fn.body)
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        body = body[1:]
    if len(body) != 1:
        return None
    only = body[0]
    return only.value if isinstance(only, ast.Return) and only.value is not None else None


def _node_count(node: ast.AST) -> int:
    return sum(1 for _ in ast.walk(node))


def _is_dependency_provider(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    """True for a FastAPI dependency (a parameter defaulting to `Depends(...)`).

    Declared per-router on purpose where they exist: `dependency_overrides` is
    keyed by the function object, so a shared one could not be overridden for
    a single app under test.
    """
    defaults = [d for d in [*fn.args.defaults, *fn.args.kw_defaults] if d is not None]
    return any(
        isinstance(d, ast.Call)
        and (getattr(d.func, "id", None) == "Depends" or getattr(d.func, "attr", None) == "Depends")
        for d in defaults
    )


def _is_pure_delegation(expr: ast.expr, params: set[str]) -> bool:
    """True for ``return f(a, b=b)`` — a call forwarding parameters unchanged.

    Such a function is a façade over another function, not a held expression:
    treating it as a template would report every ordinary call to the callee as
    a bypass of the façade, which is the opposite of what this guard means.
    """
    call = expr.value if isinstance(expr, ast.Await) else expr
    if not isinstance(call, ast.Call):
        return False
    arguments = [*call.args, *[kw.value for kw in call.keywords]]
    return all(isinstance(a, ast.Name) and a.id in params for a in arguments)


#: Node types that make an expression a *composition* rather than a lookup.
#: `JoinedStr`/`BinOp` are included because URL and key building is the
#: sibling plugins' most expensive drift shape (marketing#72 was a base URL),
#: and an f-string helper contains no call at all.
_COMPOSING_NODES = (
    ast.Call,
    ast.IfExp,
    ast.BoolOp,
    ast.Compare,
    ast.JoinedStr,
    ast.BinOp,
    ast.ListComp,
    ast.DictComp,
    ast.SetComp,
    ast.GeneratorExp,
)


def _has_structure(expr: ast.expr) -> bool:
    """True if the expression actually composes something. Pure attribute
    chains, subscripts and literals are shared by too much code to be evidence
    of anything."""
    return any(isinstance(n, _COMPOSING_NODES) for n in ast.walk(expr))


class _Helper:
    """A consolidation helper and the expression it holds."""

    def __init__(
        self, module: str, fn: ast.FunctionDef | ast.AsyncFunctionDef, expr: ast.expr
    ) -> None:
        self.module = module
        self.name = fn.name
        self.lineno = fn.lineno
        self.template = expr
        self.params = _parameter_names(fn)
        #: Node identities of the helper's own definition — the one place its
        #: expression is allowed to appear. Identity, not line numbers, so
        #: moving the function neither breaks the guard nor widens it.
        self.own_nodes = {id(n) for n in ast.walk(fn)}

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return f"{self.module}:{self.lineno} {self.name}()"


def consolidation_helpers(trees: dict[str, ast.AST]) -> list[_Helper]:
    """Every single-expression helper in the swept package, discovered from
    the tree.

    This is the sweep's **denominator**, and the reason the guard does not
    need a hand-maintained list of helper names: a helper added tomorrow lands
    here on its own.
    """
    found: list[_Helper] = []
    for module, tree in trees.items():
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            expr = _sole_returned_expression(node)
            if expr is None or _is_dependency_provider(node):
                continue
            if _node_count(expr) < _MIN_TEMPLATE_NODES or not _has_structure(expr):
                continue
            if _is_pure_delegation(expr, _parameter_names(node)):
                continue
            found.append(_Helper(module, node, expr))
    return found


# --------------------------------------------------------------------------
# Matching a call site against a helper's expression
# --------------------------------------------------------------------------

#: Fields that carry no meaning for this comparison. `ctx` is Load/Store/Del,
#: which differs between an expression that is read and one that is assigned to
#: without the expressions themselves differing at all.
_IGNORED_FIELDS = {"ctx"}


def _unifies(
    template: ast.AST, candidate: ast.AST, params: set[str], binding: dict[str, str]
) -> bool:
    """True if `candidate` is `template` with its parameters filled in.

    A parameter is a wildcard that matches any sub-expression, but must match
    the *same* sub-expression everywhere it appears — so
    ``json.loads(raw) if isinstance(raw, str) else raw`` matches a call site
    using one variable throughout and not one that mixes two.
    """
    if isinstance(template, ast.Name) and template.id in params:
        dumped = ast.dump(candidate)
        already = binding.get(template.id)
        if already is None:
            binding[template.id] = dumped
            return True
        return already == dumped

    if type(template) is not type(candidate):
        return False
    if isinstance(template, ast.Name):
        return template.id == candidate.id  # type: ignore[attr-defined]
    if isinstance(template, ast.Constant):
        other = candidate.value  # type: ignore[attr-defined]
        return type(template.value) is type(other) and template.value == other

    candidate_fields = dict(ast.iter_fields(candidate))
    for field, expected in ast.iter_fields(template):
        if field in _IGNORED_FIELDS:
            continue
        actual = candidate_fields.get(field)
        if isinstance(expected, list):
            if not isinstance(actual, list) or len(expected) != len(actual):
                return False
            for want, got in zip(expected, actual, strict=True):
                if isinstance(want, ast.AST):
                    if not isinstance(got, ast.AST) or not _unifies(want, got, params, binding):
                        return False
                elif want != got:
                    return False
        elif isinstance(expected, ast.AST):
            if not isinstance(actual, ast.AST) or not _unifies(expected, actual, params, binding):
                return False
        elif expected != actual:
            return False
    return True


def bypassing_call_sites(trees: dict[str, ast.AST]) -> list[tuple[str, str, int]]:
    """`(helper name, module, line)` for every expression that re-derives a
    helper's body outside that helper."""
    helpers = consolidation_helpers(trees)
    hits: set[tuple[str, str, int]] = set()
    for helper in helpers:
        for module, tree in trees.items():
            for node in ast.walk(tree):
                if not isinstance(node, ast.expr) or id(node) in helper.own_nodes:
                    continue
                if type(node) is not type(helper.template):
                    continue
                if _unifies(helper.template, node, helper.params, {}):
                    hits.add((helper.name, module, node.lineno))
    return sorted(hits)


def _parse_package() -> dict[str, ast.AST]:
    return {p.name: ast.parse(p.read_text(), filename=str(p)) for p in sorted(_SRC.glob("*.py"))}


# --------------------------------------------------------------------------
# The guard
# --------------------------------------------------------------------------


def test_the_swept_package_points_at_real_source() -> None:
    """A collector that silently resolves to nothing passes for the wrong
    reason. #1587 exists because the previous state of this skeleton had no
    sweep at all; this pins that `_package_dir()` actually finds this plugin's
    real, non-empty source tree rather than an empty or missing directory."""
    assert _SRC.is_dir(), f"{_SRC} does not exist — the sweep is watching nothing"
    py_files = list(_SRC.glob("*.py"))
    assert py_files, f"{_SRC} has no source files — the sweep is watching nothing"


def test_no_module_re_derives_a_shared_helpers_expression() -> None:
    offenders = [
        f"{module}:{line} re-derives {helper}()"
        for helper, module, line in bypassing_call_sites(_parse_package())
        if (helper, module) not in _ACCEPTED_DUPLICATES
    ]
    assert not offenders, (
        "These write out an expression a helper in this plugin already holds, "
        "instead of calling it (biffo-template#1587). A hand-written copy "
        "stops tracking the helper the moment the helper is corrected, and "
        "review cannot see the difference — an unconverted call site looks "
        "exactly like code that was never meant to use the helper. Call the "
        "helper, or record why this copy is correct in "
        "`_ACCEPTED_DUPLICATES`:\n  " + "\n  ".join(offenders)
    )


def test_the_guard_can_actually_fail() -> None:
    """The detector must detect, on source that is never imported.

    This plugin's real package holds zero consolidation-helper-shaped
    functions today (see the module docstring), so proving the guard against
    it would only prove it stays green over an empty denominator. This plants
    a fresh helper and a site that bypasses it instead — the same synthetic
    check the marketing reference copy uses, for the same reason.
    """
    tree = ast.parse(
        "def _normalise(raw):\n"
        '    """Hold this once."""\n'
        "    return json.loads(raw) if isinstance(raw, str) else (raw or {})\n"
        "\n"
        "def converted(row):\n"
        "    return _normalise(row.get('body'))\n"
        "\n"
        "def bypassing(row):\n"
        "    raw = row.get('body')\n"
        "    return json.loads(raw) if isinstance(raw, str) else (raw or {})\n"
    )
    assert bypassing_call_sites({"planted.py": tree}) == [("_normalise", "planted.py", 10)]


def test_a_near_miss_is_not_reported() -> None:
    """Different code must not be called drift.

    A guard that fires on anything adjacent gets waived wholesale, so the
    near-misses are pinned: a different test, a different call, and the same
    shape over two different variables are all legitimate code.

    (Each near-miss is written with a second statement so it is a call site
    rather than a helper of its own. A one-line function IS a template, and a
    template whose parameters are wildcards legitimately matches another
    helper's body — that is a duplicated *helper*, which this guard reports on
    purpose.)
    """
    tree = ast.parse(
        "def _normalise(raw):\n"
        "    return json.loads(raw) if isinstance(raw, str) else (raw or {})\n"
        "\n"
        "def different_test(row):\n"
        "    raw = row.get('body')\n"
        "    return json.loads(raw) if raw.startswith('{') else (raw or {})\n"
        "\n"
        "def different_call(row):\n"
        "    raw = row.get('body')\n"
        "    return int(raw) if isinstance(raw, str) else (raw or {})\n"
        "\n"
        "def two_variables(row, other):\n"
        "    raw = row.get('body')\n"
        "    return json.loads(raw) if isinstance(other, str) else (other or {})\n"
    )
    assert bypassing_call_sites({"planted.py": tree}) == []


def test_a_dependency_provider_is_not_treated_as_a_helper() -> None:
    """A router-style `Depends(...)` default must not be swept as a helper.

    If this exclusion were dropped, a plugin declaring the same FastAPI
    dependency provider in several routers on purpose (so
    `dependency_overrides` can replace it per app) would report every
    duplicate as an offender, and the only correct resolution would be a
    waiver — a guard that starts life with a wall of waivers is one nobody
    reads.
    """
    tree = ast.parse(
        "def get_campaign_client(admin = Depends(require_admin)):\n"
        "    return principal_client.PrincipalCoreClient(admin.token, verify=True)\n"
        "\n"
        "def other_router_provider(admin = Depends(require_admin)):\n"
        "    return principal_client.PrincipalCoreClient(admin.token, verify=True)\n"
    )
    assert consolidation_helpers({"planted.py": tree}) == []
    assert bypassing_call_sites({"planted.py": tree}) == []


def test_a_pure_delegation_is_not_treated_as_a_helper() -> None:
    """`return await self._load_owned(owner_sub=..., session_id=...)` holds no
    expression — every ordinary call to `_load_owned` would otherwise be
    reported as bypassing the façade in front of it."""
    tree = ast.parse(
        "class S:\n"
        "    async def get_session(self, *, owner_sub, session_id):\n"
        "        return await self._load_owned(owner_sub=owner_sub, session_id=session_id)\n"
        "\n"
        "    async def chat_turn(self, *, owner_sub, session_id):\n"
        "        session = await self._load_owned(owner_sub=owner_sub, session_id=session_id)\n"
        "        return session\n"
    )
    assert consolidation_helpers({"planted.py": tree}) == []


def test_no_accepted_duplicate_has_gone_stale() -> None:
    """A waiver outlives the code it excuses unless something deletes it.

    Each entry must still name a duplicate the sweep really finds. When the
    copy is consolidated or the file is renamed, this fails and the excuse goes
    with it, rather than sitting there granting a permission nobody re-examined.
    """
    live = {(helper, module) for helper, module, _ in bypassing_call_sites(_parse_package())}
    stale = sorted(pair for pair in _ACCEPTED_DUPLICATES if pair not in live)
    assert not stale, (
        "These waivers no longer excuse anything — the duplicate is gone or has "
        f"moved. Delete them: {stale}"
    )
