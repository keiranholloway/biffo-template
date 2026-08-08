"""Every literal `/api/v1/...` path the frontend calls must exist on this BFF.

biffo-template#1330 / tabsii-crm#232. Two occurrences in tabsii-crm, ten days
apart, both found only by clicking a deployed page, never by a test:

- tabsii-crm#218 — the simulation menu called a BFF route that did not exist.
- tabsii-crm#231 — the entire Finance feature, 13 paths, none served, three
  Brand HQ sections rendering `Not Found` after thirteen merged milestones.

Neither existing suite could have caught either one. The frontend's own tests
mock the API client (`createApiClient`), so the path string handed to `.get`/
`.post`/etc is never actually sent anywhere — a typo or a route that was
renamed on the BFF side is invisible to them by construction. The BFF's own
tests exercise routes it registers, and never look at what the frontend calls.
Both suites are green, CI is green, the deploy is green, and the page is dead
the moment a person opens it.

This test closes that seam from the BFF side, which is the only place that can
see both halves: it reads the frontend's source for every `/api/v1/...`
literal, and asserts each one matches a route this app actually registers —
read from the running `FastAPI` instance (see `registered_route_paths` below
for exactly how, and why not the `{r.path for r in app.routes}` this issue's
own text proposes), never a hand-maintained second list. A second list is
exactly the `_extract_detail` mistake (biffo-template#1107/#1108): written
once, drifting the moment either side changes without the other.

## What counts as a call site

Every `.ts`/`.tsx` file under `apps/frontend/src/**`, EXCLUDING `*.test.ts(x)`
and `*.spec.ts(x)`. Test files are deliberately excluded: they mock the API
client and routinely reference fictional paths (`/api/v1/courses`,
`/api/v1/modules`, ...) as illustrative fixtures for `api-client.test.ts`
itself, not as real call sites — including those would make this test fail
permanently on paths nobody's browser ever requests, which is not the class
this guards against and would just get the whole file learned-to-ignore.

## Unresolvable paths FAIL, they do not skip

A check that drops an input it cannot evaluate shrinks its own denominator and
reports the remainder as the whole — `scripts/protection-audit.sh` reporting
27 clean branches when the real number was 34 is the standing example
(AGENTS.md §2). Three shapes are extracted but deliberately treated as
unresolvable rather than matched or silently ignored, and all three FAIL the
test rather than being dropped:

1. **A computed prefix** — `` `${apiBase}/api/v1/x` `` — where the part
   *before* `/api/v1/` is an interpolation rather than a literal. This test
   has no way to know what `apiBase` evaluates to, so it cannot rule out that
   the real request never reaches `/api/v1/` at all.
2. **String concatenation** — `'/api/v1/x/' + id` (built with `+`, not a
   template-literal interpolation) — where the literal fragment this test
   would extract is incomplete on its own (`/api/v1/x/`) and comparing that
   fragment against a route template would either produce a false failure (the
   fragment alone matches nothing) or, worse, a false pass if some unrelated
   route happens to share the prefix.
3. **A template literal nested inside another's interpolation** — real shape,
   tabsii-crm's `ops-history-api.ts`:
   `` `/api/v1/ops/units/${id}/history${cond ? `?limit=${limit}` : ''}` ``.
   The extractor's regex is not nesting-aware, so it stops at the FIRST
   closing backtick it finds — the nested literal's opening one — truncating
   `raw` mid-expression. Detected in `_is_nested_template_literal_artifact`
   (a dangling `${` or a literal newline surviving into what should be a URL
   path is the tell) and routed to `unresolved_reason` rather than silently
   producing a corrupted, garbage `normalized` value that would then fail to
   match for a misleading reason — or, worse, coincidentally happen to match
   something and mask a real defect.

`${...}` interpolations *inside* an otherwise-literal template — the ordinary,
expected case, e.g. `` `/api/v1/courses/${id}` `` — are not in either category:
they are normalised to `{param}` and compared structurally (see below). There
are no concatenated or computed-prefix call sites in this skeleton today; this
is future-proofing for whatever a sibling adds, backed by
`TestExtractApiPaths` below so the behaviour is proven rather than assumed.

A third shape is common in practice and deliberately NOT unresolvable: a
literal query string appended after the path, e.g.
`` `/api/v1/board?brand_id=${id}` `` (real call sites in tabsii-crm's
`PipelineBoard.tsx` and several other components — found while checking that
repo's frontend against its BFF ahead of ever distributing this guard there).
The query string is stripped before matching, on the same basis FastAPI itself
uses: a route's path template never includes one, and the query string cannot
change which route handles the request. Treating the query string as part of
the path to match would make this guard fail a repo for something FastAPI's
own router does not care about — a false positive that would have misfired on
a real sibling the very first time it ran, so the case is proven in
`TestExtractApiPaths` rather than left to be discovered by the next repo that
tries this.

A fourth shape is the same problem one step further: a query string built as
its OWN variable and interpolated whole, with no literal `?` anywhere in the
template — tabsii-crm's `AnalyticsPanel.tsx` calls
`` `/api/v1/analytics/pipeline/funnel${query}` `` where `query` is
`` `?${params.toString()}` ``. There is no literal `?` to split on, so this is
genuinely ambiguous from the call site alone: a trailing `${...}` glued
directly onto the end of a path (nothing after it, no `/` before it) reads
exactly as plausibly as a path parameter (`.../funnel{param}`) as it does a
whole query string (`.../funnel`). Rather than guess, `alt_normalized` records
the second reading, and a match against *either* reading counts — see
`_maybe_trailing_dynamic_suffix` and `ExtractedPath.alt_normalized`. This is
still not a skip: if neither reading matches a registered route, the test
fails and reports both readings it tried (see the `UNMATCHED` message below).

## Comments are stripped first, and why that is not optional

Found while checking tabsii-crm and tabsii-lms (ahead of ever distributing
this guard, per the sequencing note in #1330): `access-scope.ts` and
`display-name.ts` each carry a `//` comment that names a historical path in a
backtick code-span for a human reader — `` // ... `/api/v1/data/roles` already
returns the whole catalogue ... `` — which is not a call site at all, but a
naive backtick-literal regex cannot tell the difference. Left unhandled, this
guard would fail real, correct repos on their own documentation, which is
exactly the kind of noise that trains people to stop reading a check
(AGENTS.md's `mustBeUniform`/orphan-ratchet posture makes the same point about
residue that blocks on arrival rather than on a regression).

`/* ... */` block comments are removed outright, and `//` line comments are
removed from the first occurrence preceded by whitespace or start-of-line
onward — deliberately NOT from the first bare `//` in the line, which would
also truncate a perfectly normal string literal like `'https://…'` (no
whitespace precedes that `//`; Prettier — this repo's own formatter — always
puts either a space or nothing-but-line-start before a real comment marker).
This is a heuristic, not a tokenizer, and a string containing a real `//`
preceded by whitespace inside its own literal could defeat it in principle —
no instance of that shape exists anywhere in this skeleton or in the two
sibling repos this was checked against, so the trade is accepted rather than
built out into a full parser for a case that has not occurred.

## Matching

Every `${...}` interpolation is normalised to the literal placeholder
`{param}` first, so `` `/api/v1/courses/${id}` `` on the frontend and
`/api/v1/courses/{course_id}` on the BFF are never expected to agree on a
parameter's *name*, only on the path's *shape* — but "shape" is decided by
asking the app's OWN router to match a concrete instance of that shape
(`path_is_registered`, below), not by comparing normalised strings against a
set built from `app.openapi()["paths"]`.

That is a deliberate departure from the more obvious design, forced by a real
route this was checked against: tabsii-crm's
`@router.get("/analytics/{report:path}")` uses FastAPI's `:path` converter,
which matches *any number of remaining segments* — `/api/v1/analytics/sources`
and `/api/v1/analytics/pipeline/funnel` both dispatch to it, at one and three
segments respectively. `app.openapi()["paths"]` reports that route as
`/api/v1/analytics/{report}`, structurally indistinguishable in the JSON from
an ordinary single-segment param — the `:path` converter is compiled into the
route's matching *regex*, not preserved in its path string, so nothing about
the OpenAPI schema alone can tell a one-segment placeholder from a
many-segment catch-all. A flat string/segment comparison would have failed
every one of `AnalyticsPanel.tsx`'s five real, working calls against this
guard the moment tabsii-crm adopted it. `registered_route_paths()` is kept
only for the human-readable route list in a failure message — it is no longer
what a match is decided against.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, FastAPI
from starlette.routing import Match

from api.main import app

REPO_ROOT = Path(__file__).resolve().parents[3]
FRONTEND_SRC = REPO_ROOT / "apps" / "frontend" / "src"

_TEST_FILE_SUFFIXES = (".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx")

_TEMPLATE_LITERAL = re.compile(r"`([^`]*)`")
_STRING_LITERAL = re.compile(r"'([^'\n]*)'|\"([^\"\n]*)\"")
_INTERPOLATION = re.compile(r"\$\{[^}]*\}")


#: Interpolated base-URL identifiers that mean "this call goes somewhere other
#: than this app's own BFF". A frontend may legitimately call the core API
#: directly for PUBLIC, unauthenticated endpoints — `${CORE_API_URL}/api/v1/
#: public/...` is real in tabsii-intake (7 call sites) and tabsii-marketplace
#: (1), found by running this guard across every sibling before distributing
#: it. Those paths are not this BFF's contract, so asserting them against its
#: route table would fail five working call sites for a fact about the guard
#: rather than about the code.
#:
#: It is an ALLOWLIST, not a wildcard, and that is the whole safety property:
#: an interpolated prefix this list does not name is still unresolvable and
#: still FAILS, so nobody can hide a real BFF path behind a computed base by
#: accident. Adding a name here is a deliberate statement that the identifier
#: denotes an external origin.
EXTERNAL_BASE_IDENTIFIERS = frozenset({"CORE_API_URL"})

_LEADING_INTERPOLATION = re.compile(r"^\$\{\s*([A-Za-z_$][\w$]*)\s*\}")


def _external_base_name(raw: str) -> str | None:
    """The identifier a path is prefixed with, when that identifier is declared
    external — otherwise None, and the caller treats it as unresolvable."""
    match = _LEADING_INTERPOLATION.match(raw)
    if match is None:
        return None
    name = match.group(1)
    return name if name in EXTERNAL_BASE_IDENTIFIERS else None


def _template_literals(text: str):
    """Every template literal in `text`, as `(content, start_index)` — scanned
    with brace and backtick depth rather than matched with a regex.

    A regex cannot do this. `` `a${ cond ? `b` : '' }c` `` contains a NESTED
    template literal inside its own interpolation, and `` `([^`]*)` `` stops at
    that inner backtick, capturing a fragment that ends mid-expression. That
    fragment is not the path — it is a truncation, and treating it as one is
    how a guard either fails for a misleading reason or, worse, coincidentally
    passes and masks the defect it exists to catch.

    So: on `${` the scanner enters an interpolation and tracks `{`/`}` depth,
    skipping any backticks inside it, and only a backtick at depth zero closes
    the literal. `/api/v1/ops/units/${id}/history${c ? `?limit=${n}` : ''}`
    (real, tabsii-crm) then yields its whole content, which normalises to a
    real path plus a trailing interpolation — a shape
    `_maybe_trailing_dynamic_suffix` already reads both ways.
    """
    i, n = 0, len(text)
    while i < n:
        if text[i] != "`":
            i += 1
            continue
        start = i + 1
        j = start
        depth = 0
        while j < n:
            ch = text[j]
            if ch == "\\":
                j += 2
                continue
            if depth == 0 and ch == "`":
                yield text[start:j], start
                break
            if ch == "$" and j + 1 < n and text[j + 1] == "{":
                depth += 1
                j += 2
                continue
            if depth:
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
            j += 1
        else:
            # Unterminated literal: not a path, and not something to guess at.
            return
        i = j + 1


_PARAM_SEGMENT = re.compile(r"\{[^}]*\}")

# ONE alternation, scanned left to right, so whichever comment construct opens
# FIRST consumes the other (#1374). Two separate passes cannot express that,
# and the order they ran in was a live fail-open:
#
#     text = _BLOCK_COMMENT.sub(...)   # ran first
#     return _LINE_COMMENT.sub(...)    # ran second
#
# A `/*` appearing as PROSE inside a `//` comment was therefore read as a real
# block-comment opener, and everything up to the file's next literal `*/` —
# in JSX, typically a `{/* ... */}` far below — was deleted. `tabsii-geo`'s
# `MapView.tsx` carried `// exclude everything under basemap/*) from the S3
# deploy`, which swallowed ~180 lines including BOTH of that repo's real call
# sites. The guard extracted 0 paths and PASSED.
#
# `re.sub` takes the leftmost match, so a single alternation gets this right in
# both directions: a `//` opening first consumes any `/*` on its line, and a
# `/*` opening first consumes any `//` inside it.
#
# The `//` branch requires whitespace or start-of-line before it, NOT a bare
# `//`, which would also truncate a `'https://…'` string literal — see the
# module docstring's "Comments are stripped first" section for the real false
# positives (tabsii-crm, tabsii-lms) that rule exists to stop.
#
# An UNTERMINATED `/*` matches nothing and is left in place, deliberately:
# deleting to end-of-file on a malformed comment is the very blindness this
# fix exists to remove.
_COMMENT = re.compile(r"/\*.*?\*/|(?:^|(?<=\s))//[^\n]*", re.DOTALL | re.MULTILINE)

API_PREFIX = "/api/v1/"


def _strip_comments(text: str) -> str:
    """Remove `/* ... */` and `// ...` so a comment merely mentioning a path
    — in prose, as documentation — is never mistaken for a call site.

    A comment is replaced by the same number of newlines it contained, not
    deleted outright — this codebase leans heavily on multi-line `/** */`
    JSDoc, and dropping those newlines would shift every subsequent line
    number, misdirecting a failure message at the wrong line for anything
    below one. A `//` comment contains no newline, so the same substitution
    correctly erases it to nothing.

    See `_COMMENT` for why this is one pass rather than two, and for the
    fail-open (#1374) that the two-pass version caused.
    """
    return _COMMENT.sub(lambda m: "\n" * m.group(0).count("\n"), text)


@dataclass(frozen=True)
class ExtractedPath:
    """One `/api/v1/...` literal found in the frontend source.

    `normalized` is the comparable path with every dynamic segment collapsed
    to `{param}`, or `None` when the path cannot be resolved at all — see
    `unresolved_reason` for why, which is always set exactly when `normalized`
    is not.

    `alt_normalized` covers one specific, real ambiguity (see
    `_maybe_trailing_dynamic_suffix` below): a trailing `${...}` glued
    directly onto the end of the last path segment, with nothing after it and
    no `/` before it, reads identically whether the variable holds a path
    parameter or a query string built elsewhere and interpolated whole
    (tabsii-crm's `` `/api/v1/analytics/pipeline/funnel${query}` `` is the
    real example this was found against). Either `normalized` or
    `alt_normalized` matching a registered route counts as a match; this is
    still a FAIL when neither does, never a skip.
    """

    file: Path
    line: int
    raw: str
    normalized: str | None
    unresolved_reason: str | None
    alt_normalized: str | None = None
    #: Set when the path is prefixed with a DECLARED external base
    #: (`EXTERNAL_BASE_IDENTIFIERS`), meaning it never reaches this BFF. Such a
    #: path is neither matched nor unresolved: it is out of this guard's scope
    #: by a stated rule, and is reported in the denominator as its own count so
    #: "all matched" can never quietly mean "we stopped looking at five".
    external_base: str | None = None


def _line_number(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def _touches_concatenation(text: str, start: int, end: int) -> bool:
    """True when a `+` sits immediately beside the literal (outside quotes).

    Checked in a small window on both sides rather than adjacent characters
    only, so whitespace around the operator (`'/api/v1/x/' + id`, or
    `'/api/v1/x/'+id`) does not let a concatenated fragment slip through as if
    it were a complete, standalone path.
    """
    window = 40
    after = text[end : end + window].lstrip()
    before = text[max(0, start - window) : start].rstrip()
    return after.startswith("+") or before.endswith("+")


def _relative(path: Path) -> str:
    return str(path.relative_to(REPO_ROOT))


def _resolve_interpolations(raw: str) -> str:
    """Replace every BALANCED `${...}` with `{param}`, tracking brace depth.

    `_INTERPOLATION`'s `[^}]*` stops at the first `}` it meets, which is the
    wrong one whenever an interpolation contains a nested template literal
    with its own interpolation inside it — `${c ? `?limit=${n}` : ''}` gets
    cut after `${n}`, leaving `: ''}` behind as if it were path text. Depth
    tracking is the only thing that reads that correctly.

    An interpolation that never closes is left exactly as it is, so
    `_is_nested_template_literal_artifact` can still see the `${` and fail
    loudly rather than guess.
    """
    out: list[str] = []
    i, n = 0, len(raw)
    while i < n:
        if raw[i] == "$" and i + 1 < n and raw[i + 1] == "{":
            depth, j = 1, i + 2
            while j < n and depth:
                if raw[j] == "{":
                    depth += 1
                elif raw[j] == "}":
                    depth -= 1
                j += 1
            if depth:
                out.append(raw[i:])
                break
            out.append("{param}")
            i = j
            continue
        out.append(raw[i])
        i += 1
    return "".join(out)


def _is_nested_template_literal_artifact(raw: str) -> bool:
    """True when `raw` is almost certainly not the true content of the
    template literal it was extracted from — a truncation, not a real path.

    `_TEMPLATE_LITERAL` is a plain, non-nesting regex: it matches from an
    opening backtick to the very next backtick, full stop. A JS/TS template
    literal containing a NESTED one inside its own interpolation — tabsii-crm's
    `` `/api/v1/ops/units/${id}/history${ cond ? `?limit=${limit}` : '' }` ``
    (real, found while checking that repo ahead of ever distributing this
    guard there) — has an inner backtick before its real closing one, so the
    regex stops there instead, capturing `raw` as everything up to that INNER
    opening backtick: a fragment ending mid-expression, with a dangling `${`
    and a literal newline in what should be a URL path.

    Detected two ways, either sufficient on its own: a literal newline (no
    real API path contains one), or a `${` that survives resolution
    unresolved (every WELL-FORMED interpolation closes with a matching `}`
    and gets replaced; one that does not close within the captured text is
    exactly what a truncation looks like). This is a heuristic, not a full
    tokenizer — see the module docstring's "Comments are stripped first"
    section for the same trade made elsewhere in this file — and rather than
    risk silently producing a plausible-looking but WRONG normalised path
    (which would fail the guard for the wrong, misleading reason, or worse,
    coincidentally NOT fail and mask a real defect), a detected truncation is
    routed to `unresolved_reason` and FAILS loudly, per the module docstring's
    "Unresolvable paths FAIL, they do not skip" rule.
    """
    resolved = _resolve_interpolations(raw)
    if "${" in resolved:
        # An interpolation that never closes: the capture really is truncated.
        return True
    # A newline in the PATH text is impossible; one inside an interpolation is
    # just Prettier wrapping a long ternary, and `_template_literals` now
    # captures those whole rather than stopping at the inner backtick. So the
    # newline test has to run AFTER interpolations are resolved away, or every
    # multi-line-formatted call site reads as a truncation it is not.
    return "\n" in resolved


def _strip_query_string(raw: str) -> str:
    """Drop a literal `?...` suffix — FastAPI route templates never include
    one, and it cannot change which route handles the request, so keeping it
    in the comparable path would fail a real, working call site (see the
    module docstring's third shape)."""
    return raw.split("?", 1)[0]


# Matches the RESOLVED form: interpolations are turned into `{param}` before
# this runs (see the ordering note in `extract_api_paths`), so a trailing
# dynamic suffix looks like `{param}` at the end, not `${...}`.
_TRAILING_INTERPOLATION = re.compile(r"\{param\}$")


def _maybe_trailing_dynamic_suffix(path_only: str) -> str | None:
    """The alternate reading for a trailing `${...}` with no `/` before it.

    `/api/v1/analytics/pipeline/funnel${query}` (tabsii-crm, real) is exactly
    as plausible read as "a path parameter glued onto the segment with no
    separator" (`.../funnel{param}`, `normalized`'s reading) as it is "a query
    string built elsewhere and interpolated whole" (`.../funnel`, dropping it
    entirely) — the two are genuinely indistinguishable from the call site
    alone, and `query` there is in fact built as `` `?${params.toString()}` ``.

    Returns `None` when there is no trailing interpolation glued directly
    onto the end (nothing to disambiguate), so callers can tell "not
    applicable" from "applies, and resolves to the empty suffix".
    """
    match = _TRAILING_INTERPOLATION.search(path_only)
    if match is None:
        return None
    before = path_only[: match.start()]
    if before.endswith("/"):
        return None  # a genuine path segment, not a glued-on suffix
    return before


def extract_api_paths(text: str, file: Path) -> list[ExtractedPath]:
    """Every `/api/v1/...` literal or template in `text`, resolved or not.

    Comments are stripped first (see `_strip_comments`) — a path merely
    mentioned in a `//` or `/* */` comment is not a call site.
    """
    text = _strip_comments(text)
    found: list[ExtractedPath] = []

    for _content, _start in _template_literals(text):
        raw = _content
        _end = _start + len(_content)
        if raw.startswith(API_PREFIX):
            if _touches_concatenation(text, _start - 1, _end + 1):
                found.append(
                    ExtractedPath(
                        file,
                        _line_number(text, _start),
                        raw,
                        None,
                        "built with string concatenation (+) — the extracted "
                        "literal is a fragment, not the whole path",
                    )
                )
            elif _is_nested_template_literal_artifact(raw):
                found.append(
                    ExtractedPath(
                        file,
                        _line_number(text, _start),
                        raw,
                        None,
                        "contains a template literal nested inside its own "
                        "interpolation (e.g. a conditional query string built "
                        "with a second backtick-quoted expression) — this "
                        "extractor's regex is not nesting-aware and would "
                        "otherwise truncate at the inner backtick, producing "
                        "a corrupted path rather than a real mismatch",
                    )
                )
            else:
                # Resolve interpolations BEFORE splitting off the query
                # string. A ternary inside an interpolation carries its own
                # `?` (`${c ? `?limit=${n}` : ""}`), and splitting first
                # truncates the path at that operator — which reads as a
                # missing route rather than as the parsing bug it is.
                path_only = _strip_query_string(_resolve_interpolations(raw))
                normalized = path_only
                alt_base = _maybe_trailing_dynamic_suffix(path_only)
                alt_normalized = alt_base
                found.append(
                    ExtractedPath(
                        file,
                        _line_number(text, _start),
                        raw,
                        normalized,
                        None,
                        alt_normalized,
                    )
                )
        elif (_base := _external_base_name(raw)) is not None and API_PREFIX in raw:
            # Prefixed with a DECLARED external origin, so it never reaches
            # this BFF at all — counted and reported, never silently dropped.
            found.append(
                ExtractedPath(
                    file,
                    _line_number(text, _start),
                    raw,
                    None,
                    None,
                    None,
                    _base,
                )
            )
        elif API_PREFIX in raw:
            # Contains it, but does not start with it: the segment before
            # `/api/v1/` is itself an interpolation (`${apiBase}/api/v1/x`),
            # so this test cannot know what actually precedes the request.
            found.append(
                ExtractedPath(
                    file,
                    _line_number(text, _start),
                    raw,
                    None,
                    "computed path prefix — an interpolation precedes "
                    f"{API_PREFIX!r}, so the real request target is unknown",
                )
            )

    for match in _STRING_LITERAL.finditer(text):
        raw = match.group(1) if match.group(1) is not None else match.group(2)
        if not raw.startswith(API_PREFIX):
            continue
        if _touches_concatenation(text, match.start(), match.end()):
            found.append(
                ExtractedPath(
                    file,
                    _line_number(text, match.start()),
                    raw,
                    None,
                    "built with string concatenation (+) — the extracted "
                    "literal is a fragment, not the whole path",
                )
            )
        else:
            normalized = _strip_query_string(raw)
            found.append(
                ExtractedPath(file, _line_number(text, match.start()), raw, normalized, None)
            )

    return found


def _frontend_source_files() -> list[Path]:
    """`.ts`/`.tsx` call sites under `apps/frontend/src/**`, tests excluded.

    Test files are excluded deliberately, not by omission — see the module
    docstring. They mock the API client, so a path string inside one is a
    fixture value, never something a browser actually requests.
    """
    candidates = [*FRONTEND_SRC.rglob("*.ts"), *FRONTEND_SRC.rglob("*.tsx")]
    return sorted(p for p in candidates if not p.name.endswith(_TEST_FILE_SUFFIXES))


def registered_route_paths() -> set[str]:
    """This BFF's own registered route templates, normalised for display.

    Read from the live `FastAPI` app — never a hand-maintained second list,
    which is precisely how #1107/#1108 (`_extract_detail`) and #218/#231 (this
    issue) happened: two copies of the same fact, kept in step by nothing.

    Deliberately `app.openapi()["paths"]`, not `{r.path for r in app.routes}`
    as biffo-template#1330 proposes: on the FastAPI version this skeleton
    actually pins (0.139.0), `app.include_router(...)` defers expansion behind
    an internal `_IncludedRouter` wrapper with no `.path` of its own, so
    walking `app.routes` and skipping anything without `.path` silently
    returns only the three auto-generated meta-routes (`/openapi.json`,
    `/api/docs`, `/docs/oauth2-redirect`) and NONE of the app's real routes —
    confirmed by running exactly that snippet against this app before writing
    this function. That is the same failure shape this whole test exists to
    prevent, one level in: a check that quietly evaluates against less than it
    thinks it does. `app.openapi()` is the documented, version-stable way to
    ask "what does this app actually serve": it walks whatever internal
    representation the installed FastAPI uses and returns the fully-resolved
    path templates (prefixes already applied, params already in `{name}`
    form), so it does not need to know about `_IncludedRouter` or whatever
    FastAPI's next refactor replaces it with.

    Used only to build the human-readable route list in a failure message —
    see `path_is_registered` for what a match is actually decided against, and
    why this set alone is not enough (the `:path`-converter case).
    """
    schema = app.openapi()
    paths: set[str] = set(schema.get("paths", {}).keys())
    return {_PARAM_SEGMENT.sub("{param}", path) for path in paths}


_PLACEHOLDER_SEGMENT = "x"


def _concrete_candidate(normalized: str) -> str:
    """A `{param}`-templated path turned into one concrete instance — an
    ordinary, inert path segment with no special meaning to any router."""
    return normalized.replace("{param}", _PLACEHOLDER_SEGMENT)


def path_is_registered(fastapi_app: FastAPI, normalized: str) -> bool:
    """Does a concrete instance of this template dispatch to ANY route this
    app registers?

    Asks the app's OWN router — `route.matches(scope)`, the exact mechanism a
    real request goes through — rather than reconstructing FastAPI's path
    semantics as a second, parallel implementation. That distinction is not
    tidiness: a flat string/segment comparison cannot represent a `:path`
    converter at all. `@router.get("/analytics/{report:path}")` (a real route
    in tabsii-crm) matches any number of trailing segments, so
    `/api/v1/analytics/{param}` (one segment) and
    `/api/v1/analytics/pipeline/funnel` (three) are never equal as strings,
    yet the same real request dispatches to that one route either way — see
    the module docstring's "Matching" section for how this was found. Only
    Starlette's own compiled route regex — reached through `.matches()`, never
    re-derived from `app.openapi()`'s already-flattened path strings, which do
    not preserve which converter a segment used — knows that.

    `Match.NONE` means no match at all; `Match.PARTIAL` means the path matched
    but the HTTP method did not. Either non-`NONE` result means a route
    exists for this path shape, which is the only question this guard asks —
    it does not care which verb the frontend used.
    """
    candidate = _concrete_candidate(normalized)
    scope = {"type": "http", "path": candidate, "method": "GET", "path_params": {}}
    for route in fastapi_app.routes:
        match, _ = route.matches(scope)
        if match != Match.NONE:
            return True
    return False


def test_the_extractor_is_not_blind() -> None:
    """Zero extracted paths must mean "none there", never "could not see".

    `test_every_frontend_api_v1_path_is_registered_on_the_bff` cannot tell the
    difference on its own: it iterates whatever the extractor returned, so an
    extractor that returns nothing passes it trivially. Every other safeguard
    in this file — `unresolved` failing rather than skipping, the reported
    denominator, the declared external allowlist — protects against a path
    that is SEEN and cannot be resolved. None of them protects against text
    the extractor never receives.

    That is not hypothetical. #1374: `_strip_comments` ran its block-comment
    pass before its line-comment pass, so a `/*` in prose inside a `//`
    comment opened a phantom block that deleted ~180 lines of `tabsii-geo`'s
    `MapView.tsx`, including both of its real call sites. The suite reported
    `0 found ... 0 did not match` and passed. It was caught only because the
    sweep that adopted this guard required a raw-grep cross-check of the
    extracted count rather than trusting a green test.

    So the cross-check is now part of the guard. Comparing against the RAW
    text — before any stripping — is the point: the raw scan is the one thing
    a bug in the stripping cannot affect.

    **What this does and does not catch.** It catches TOTAL blindness over the
    file set, which is the shape a stripping bug takes when it swallows a
    span. It does not catch partial loss — three call sites eaten while a
    fourth survives still passes here. Stated plainly rather than overclaimed;
    the one-pass `_COMMENT` scanner is what addresses the partial case, and
    this is the backstop for the next bug of a kind nobody has thought of.

    A repo with genuinely no in-source API calls still passes, because the raw
    scan reads exactly the same file set the extractor does — test files
    excluded. `tabsii-app` is the real example: its only `/api/v1` text lives
    in `lib/api-client.test.ts`, so raw and extracted are both 0 and that is
    an honest clean.
    """
    files = _frontend_source_files()
    raw_hits = [(f, f.read_text(encoding="utf-8").count(API_PREFIX)) for f in files]
    raw_total = sum(n for _, n in raw_hits)

    extracted = 0
    for file in files:
        extracted += len(extract_api_paths(file.read_text(encoding="utf-8"), file))

    if raw_total and not extracted:
        offenders = "\n".join(f"  {_relative(f)}: {n} raw occurrence(s)" for f, n in raw_hits if n)
        raise AssertionError(
            f"The extractor found 0 `{API_PREFIX}` path(s) across "
            f"{len(files)} frontend source file(s), but the raw text of those "
            f"same files contains {raw_total}. That is blindness, not a clean "
            f"pass — something is consuming the source before extraction "
            f"reaches it (#1374 was exactly this: a `/*` in prose inside a "
            f"`//` comment swallowing the rest of the file).\n{offenders}"
        )


def test_every_frontend_api_v1_path_is_registered_on_the_bff() -> None:
    extracted: list[ExtractedPath] = []
    for file in _frontend_source_files():
        extracted.extend(extract_api_paths(file.read_text(encoding="utf-8"), file))

    external = [p for p in extracted if p.external_base is not None]
    in_scope = [p for p in extracted if p.external_base is None]
    resolved = [p for p in in_scope if p.normalized is not None]
    unresolved = [p for p in in_scope if p.normalized is None]

    def _is_matched(p: ExtractedPath) -> bool:
        if p.normalized is not None and path_is_registered(app, p.normalized):
            return True
        return p.alt_normalized is not None and path_is_registered(app, p.alt_normalized)

    unmatched = [p for p in resolved if not _is_matched(p)]
    matched_count = len(resolved) - len(unmatched)

    # The denominator, always reported — never just "N failures" with no sense
    # of how many paths were even in scope. A share with an invisible
    # denominator is how #1330's own motivating class ("27 clean branches"
    # when the real count was 34) recurs one level up.
    summary = (
        f"{len(extracted)} /api/v1/... path template(s) found under "
        f"apps/frontend/src/** ({_relative(FRONTEND_SRC)}); "
        f"{matched_count} matched a route this BFF registers, "
        f"{len(unmatched)} did not, {len(unresolved)} could not be resolved "
        f"at all, {len(external)} target a declared external base and are out "
        "of this BFF's scope."
    )

    lines = [summary]
    for p in unmatched:
        readings = (
            repr(p.normalized)
            if p.alt_normalized is None
            else (f"{p.normalized!r} or {p.alt_normalized!r}")
        )
        lines.append(
            f"  UNMATCHED  {_relative(p.file)}:{p.line}  {p.raw!r} "
            f"-> normalised {readings}, no BFF route matches either"
        )
    for p in unresolved:
        lines.append(
            f"  UNRESOLVED {_relative(p.file)}:{p.line}  {p.raw!r} -> {p.unresolved_reason}"
        )
    for p in external:
        # Reported even though they pass, so the excluded set stays visible
        # rather than becoming a silent hole in the denominator.
        lines.append(
            f"  EXTERNAL   {_relative(p.file)}:{p.line}  {p.raw!r} "
            f"-> prefixed with ${{{p.external_base}}}, declared external"
        )
    if unmatched or unresolved:
        # Display only -- `path_is_registered` above is what actually decided
        # pass/fail; see its docstring for why this flattened set cannot be
        # used for the decision itself.
        lines.append(f"\nRoutes this BFF registers: {sorted(registered_route_paths())}")

    assert not unmatched and not unresolved, "\n".join(lines)


class TestExtractApiPaths:
    """`extract_api_paths` in isolation, so its handling of each shape is
    proven rather than only exercised indirectly through whatever this
    skeleton's frontend happens to contain today (currently: one literal
    call, `/api/v1/whoami`, and no concatenated or computed-prefix call sites
    at all)."""

    def test_plain_literal_resolves_unchanged(self) -> None:
        found = extract_api_paths("api.get('/api/v1/whoami')", Path("x.ts"))
        assert len(found) == 1
        assert found[0].normalized == "/api/v1/whoami"
        assert found[0].unresolved_reason is None

    def test_template_interpolation_normalises_to_param(self) -> None:
        found = extract_api_paths("api.get(`/api/v1/courses/${id}`)", Path("x.ts"))
        assert len(found) == 1
        assert found[0].normalized == "/api/v1/courses/{param}"

    def test_multiple_interpolations_all_normalise(self) -> None:
        found = extract_api_paths(
            "api.get(`/api/v1/courses/${courseId}/modules/${moduleId}`)", Path("x.ts")
        )
        assert len(found) == 1
        assert found[0].normalized == "/api/v1/courses/{param}/modules/{param}"

    def test_string_concatenation_is_unresolved_not_skipped(self) -> None:
        found = extract_api_paths("api.get('/api/v1/courses/' + id)", Path("x.ts"))
        assert len(found) == 1
        assert found[0].normalized is None
        assert found[0].unresolved_reason is not None
        assert "concatenation" in found[0].unresolved_reason

    def test_concatenation_before_the_literal_is_also_unresolved(self) -> None:
        found = extract_api_paths("api.get(prefix + '/api/v1/courses')", Path("x.ts"))
        assert len(found) == 1
        assert found[0].normalized is None

    def test_query_string_is_stripped_not_treated_as_part_of_the_path(self) -> None:
        # Real shape, not hypothetical: tabsii-crm's PipelineBoard.tsx calls
        # `/api/v1/board?brand_id=${encodeURIComponent(brandId)}` against a
        # route registered as plain `/api/v1/board` — found while checking
        # that repo's frontend against its BFF ahead of distributing this
        # guard there. Without stripping the query string this would fail a
        # real, working call site: FastAPI's own router does not consider the
        # query string part of the path template it dispatches on.
        found = extract_api_paths(
            "api.get(`/api/v1/board?brand_id=${encodeURIComponent(brandId)}`)", Path("x.ts")
        )
        assert len(found) == 1
        assert found[0].normalized == "/api/v1/board"
        assert found[0].unresolved_reason is None

    def test_query_string_on_a_plain_string_literal_is_also_stripped(self) -> None:
        found = extract_api_paths("api.get('/api/v1/units?active=true')", Path("x.ts"))
        assert len(found) == 1
        assert found[0].normalized == "/api/v1/units"

    def test_trailing_interpolation_with_no_slash_gets_an_alt_reading(self) -> None:
        # Real shape, not hypothetical: tabsii-crm's AnalyticsPanel.tsx calls
        # `/api/v1/analytics/pipeline/funnel${query}` where `query` is built
        # separately as `` `?${params.toString()}` `` — no literal `?` in
        # this template for `_strip_query_string` to find. `normalized` reads
        # it as a path param glued on with no separator; `alt_normalized`
        # reads it as the whole trailing query string, i.e. dropped.
        found = extract_api_paths(
            "api.get(`/api/v1/analytics/pipeline/funnel${query}`)", Path("x.ts")
        )
        assert len(found) == 1
        assert found[0].normalized == "/api/v1/analytics/pipeline/funnel{param}"
        assert found[0].alt_normalized == "/api/v1/analytics/pipeline/funnel"

    def test_interpolation_after_a_slash_is_not_treated_as_ambiguous(self) -> None:
        # `.../courses/${id}` is an ordinary path parameter -- the `/`
        # immediately before `${` is exactly what distinguishes it from the
        # glued-on-suffix shape above, so there is nothing to disambiguate.
        found = extract_api_paths("api.get(`/api/v1/courses/${id}`)", Path("x.ts"))
        assert len(found) == 1
        assert found[0].alt_normalized is None

    def test_a_path_named_only_in_a_line_comment_is_not_a_call_site(self) -> None:
        # Real shape, not hypothetical: tabsii-crm's access-scope.ts and
        # display-name.ts each have a `//` comment naming a path in a
        # backtick code-span for a human reader
        # (`` /api/v1/data/roles already returns the whole catalogue ``) —
        # found while checking that repo ahead of ever distributing this
        # guard there. Neither is a call site.
        found = extract_api_paths(
            "// see `/api/v1/data/roles` for the full catalogue\napi.get('/api/v1/roles')",
            Path("x.ts"),
        )
        assert len(found) == 1
        assert found[0].normalized == "/api/v1/roles"

    def test_a_path_named_only_in_a_block_comment_is_not_a_call_site(self) -> None:
        found = extract_api_paths(
            "/** deprecated: used to call `/api/v1/legacy/x` */\napi.get('/api/v1/whoami')",
            Path("x.ts"),
        )
        assert len(found) == 1
        assert found[0].normalized == "/api/v1/whoami"

    def test_a_block_opener_in_prose_inside_a_line_comment_eats_nothing(self) -> None:
        """#1374, reduced from `tabsii-geo`'s `MapView.tsx` verbatim.

        The `basemap/*)` in that comment is prose — a glob in an English
        sentence about an S3 deploy exclusion. The two-pass stripper read its
        `/*` as a real block-comment opener and deleted everything up to the
        next literal `*/`, which in a `.tsx` file is the JSX comment below.
        Both real call sites vanished and the suite reported a clean pass.
        """
        found = extract_api_paths(
            "// exclude everything under basemap/*) from the S3 deploy\n"
            "api.get('/api/v1/units')\n"
            "api.get('/api/v1/regions')\n"
            "{/* an ordinary JSX comment */}\n"
            "api.get('/api/v1/brands')\n",
            Path("MapView.tsx"),
        )
        assert [p.normalized for p in found] == [
            "/api/v1/units",
            "/api/v1/regions",
            "/api/v1/brands",
        ]

    def test_a_line_comment_marker_inside_a_block_comment_eats_nothing(self) -> None:
        """The mirror case, which a naive "just swap the two passes" fix
        breaks: a `//` inside a block comment must not end the block early and
        leave its `*/` behind as live source."""
        found = extract_api_paths(
            "/* see //example.com for why\n"
            "   this used to call /api/v1/legacy */\n"
            "api.get('/api/v1/whoami')\n",
            Path("x.ts"),
        )
        assert [p.normalized for p in found] == ["/api/v1/whoami"]

    def test_an_unterminated_block_comment_does_not_eat_the_rest_of_the_file(
        self,
    ) -> None:
        """Deleting to end-of-file on a malformed comment is the same
        blindness in a different costume, so an unterminated `/*` is left in
        place and the code after it is still read."""
        found = extract_api_paths(
            "/* oops, never closed\napi.get('/api/v1/whoami')\n",
            Path("x.ts"),
        )
        assert [p.normalized for p in found] == ["/api/v1/whoami"]

    def test_comment_stripping_still_preserves_line_numbers(self) -> None:
        """The one-pass scanner must keep the property the two-pass version
        had: a failure message points at the real line."""
        found = extract_api_paths(
            "/* a\n   multi\n   line\n   comment */\napi.get('/api/v1/whoami')\n",
            Path("x.ts"),
        )
        assert len(found) == 1
        assert found[0].line == 5

    def test_a_url_containing_double_slash_is_not_mistaken_for_a_comment(self) -> None:
        found = extract_api_paths(
            "const base = 'https://example.com'\napi.get('/api/v1/whoami')",
            Path("x.ts"),
        )
        assert len(found) == 1
        assert found[0].normalized == "/api/v1/whoami"

    def test_block_comment_stripping_preserves_line_numbers(self) -> None:
        found = extract_api_paths(
            "/**\n * a multi-line\n * jsdoc block\n */\napi.get('/api/v1/whoami')",
            Path("x.ts"),
        )
        assert len(found) == 1
        assert found[0].line == 5

    def test_computed_prefix_is_unresolved_not_skipped(self) -> None:
        found = extract_api_paths("api.get(`${apiBase}/api/v1/courses`)", Path("x.ts"))
        assert len(found) == 1
        assert found[0].normalized is None
        assert found[0].unresolved_reason is not None
        assert "computed path prefix" in found[0].unresolved_reason

    def test_a_path_with_no_api_v1_prefix_at_all_is_ignored(self) -> None:
        found = extract_api_paths("const url = '/health'; const other = `${x}/y`", Path("x.ts"))
        assert found == []

    def test_nested_template_literal_resolves_rather_than_being_given_up_on(self) -> None:
        # Real shape, not hypothetical: tabsii-crm's ops-history-api.ts builds
        # a conditional query string as its own nested template literal —
        # found by running this guard against that repo before distributing it.
        #
        # A plain `` `([^`]*)` `` regex truncates at the NESTED backtick, and
        # the first version of this guard therefore declared the path
        # unresolvable and failed loudly. That was the right call over
        # guessing, but it left the guard unable to pass in the one repo whose
        # defect motivated it — so it could never have been distributed.
        # `_template_literals` and `_resolve_interpolations` now track brace
        # and backtick depth, so the path resolves for real. It is the ONLY
        # unresolvable case either repo had.
        found = extract_api_paths(
            "api.get(\n"
            "  `/api/v1/ops/units/${encodeURIComponent(unitId)}/history${\n"
            "    limit !== undefined ? `?limit=${limit}` : ''\n"
            "  }`,\n"
            ")",
            Path("x.ts"),
        )
        assert len(found) == 1
        assert found[0].unresolved_reason is None
        # The ternary's own `?` must not be mistaken for the query separator:
        # resolving interpolations has to happen BEFORE the query string is
        # split off, or the path truncates at `limit !== undefined `.
        assert found[0].normalized == "/api/v1/ops/units/{param}/history{param}"
        # ...and the trailing suffix keeps its alternate reading, which is the
        # one that matches the registered route.
        assert found[0].alt_normalized == "/api/v1/ops/units/{param}/history"

    def test_is_nested_template_literal_artifact_accepts_well_formed_paths(self) -> None:
        # Sanity check on the detector itself: it must not flag ordinary,
        # correctly-extracted paths as artifacts, or every real call site
        # would spuriously fail alongside the truncated ones.
        assert _is_nested_template_literal_artifact("/api/v1/whoami") is False
        assert _is_nested_template_literal_artifact("/api/v1/courses/${id}") is False
        assert (
            _is_nested_template_literal_artifact("/api/v1/courses/${courseId}/modules/${moduleId}")
            is False
        )

    def test_registered_route_paths_normalises_fastapi_params(self) -> None:
        registered = registered_route_paths()
        assert "/api/v1/whoami" in registered
        assert "/api/v1/health" in registered
        assert all("{" not in r or r.count("{param}") == r.count("{") for r in registered)


class TestPathIsRegistered:
    """`path_is_registered` in isolation, against both this skeleton's real
    app and a throwaway one built to carry the shape that broke a flat
    string/segment comparison: a `:path` converter."""

    def test_matches_a_plain_registered_route(self) -> None:
        assert path_is_registered(app, "/api/v1/whoami") is True

    def test_matches_a_registered_route_through_its_param(self) -> None:
        # sanity: the matcher is not simply "true for everything"
        assert path_is_registered(app, "/api/v1/whoami/{param}") is False

    def test_rejects_a_genuinely_unregistered_path(self) -> None:
        # The tabsii-crm#231 shape, reproduced directly: a path with no route
        # behind it at all.
        assert path_is_registered(app, "/api/v1/finance/reports") is False

    def test_a_path_converter_catch_all_matches_any_number_of_segments(self) -> None:
        # Real shape, not hypothetical: tabsii-crm's analytics.py registers
        # `@router.get("/analytics/{report:path}")`, and AnalyticsPanel.tsx
        # legitimately calls it at both one segment
        # (`/api/v1/analytics/sources`) and effectively three
        # (`/api/v1/analytics/pipeline/funnel`) — found while checking that
        # repo's frontend against its BFF ahead of ever distributing this
        # guard there. A flat string/segment comparison could only ever
        # accept ONE of those shapes; `path_is_registered` accepts both,
        # because Starlette's own compiled route regex does.
        catchall_app = FastAPI()
        catchall_router = APIRouter()

        @catchall_router.get("/analytics/{report:path}")
        async def _report(report: str) -> dict[str, str]:
            return {"report": report}

        catchall_app.include_router(catchall_router, prefix="/api/v1")

        assert path_is_registered(catchall_app, "/api/v1/analytics/{param}") is True
        assert path_is_registered(catchall_app, "/api/v1/analytics/pipeline/funnel") is True
        assert path_is_registered(catchall_app, "/api/v1/analytics/pipeline/funnel/{param}") is True
        assert path_is_registered(catchall_app, "/api/v1/other/path") is False
