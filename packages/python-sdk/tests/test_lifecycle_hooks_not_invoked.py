"""Guard: the plugin lifecycle hooks are dead, and the docs must keep saying so.

``BiffoPluginBase.on_install`` / ``on_uninstall`` / ``on_upgrade`` are declared,
are abstract, are implemented by every plugin in this estate — and are **called
by nothing**. ADR-0003 section 9 described a CLI that would invoke them; that
call site was never built. The documentation nevertheless asserted the opposite
for a year ("The CLI calls ``on_install()``…"), and the plugin skeleton
*demonstrated seeding through the hook*, so the natural thing for a new plugin
author to copy was a seed that silently never runs. That is not a theoretical
cost: it burned 1h20m on one investigation, where a plugin deployed clean, its
tables were empty, and the symptom surfaced three layers away
(biffo-template#709, biffo-template#924).

The fix was documentation, not machinery — which means the only thing keeping it
fixed is this test. Two directions are guarded:

- **The claim.** No file may say the hooks are invoked, and every file that
  mentions them at all must carry the words "not invoked".
- **The fact.** Nothing may actually invoke them. If someone *does* wire the
  hooks up (ADR-0003 section 9's option 1), :func:`test_nothing_invokes_the_hooks`
  fails — deliberately. That failure is the signal to rewrite the docs to match
  the new truth and delete the other half of this guard, rather than to leave a
  repo where half the sentences are right.

``docs/practices/`` and ``docs/guides/development-practices.md`` are excluded:
they are the estate's evidence log, they discuss these hooks in the past tense as
a recorded lesson, and rewriting history to satisfy a guard would destroy the
record this guard exists because of.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
SDK_PLUGIN_MODULE = PACKAGE_ROOT / "src" / "biffo_plugin_sdk" / "plugin.py"
REPO_ROOT = PACKAGE_ROOT.parent.parent

#: The three declared-but-uncalled hooks.
HOOKS = ("on_install", "on_uninstall", "on_upgrade")

#: The words a file mentioning a hook must carry. Deliberately a plain phrase
#: rather than a machine token: it has to read naturally in a docstring, an ADR
#: and a README, because a marker nobody reads is a marker nobody keeps true.
MARKER = "not invoked"

_HOOK_RE = re.compile("|".join(HOOKS))
_MARKER_RE = re.compile(re.escape(MARKER), re.IGNORECASE)

#: Verbs that assert the hook actually runs.
_INVOCATION_RE = re.compile(
    r"\b(?:call|calls|called|calling|invoke|invokes|invoking|invoked|fire|fires|fired)\b",
    re.IGNORECASE,
)

#: Anything that turns such a sentence into a denial, a hypothetical or a
#: historical note. Kept generous on purpose — a false *pass* here costs one
#: unguarded sentence, a false *failure* costs every future author's trust in
#: the guard.
_NEGATION_RE = re.compile(
    r"\b(?:not|never|no|none|nothing|nobody|without|would|were|was|dead|"
    r"un-?invoked|un-?called|claimed|used to|stale|wrongly|falsely)\b",
    re.IGNORECASE,
)

#: Extensions worth scanning. Lockfiles, binaries and generated artefacts are
#: not documentation and cannot mislead a reader.
_TEXT_SUFFIXES = {".py", ".md", ".json", ".ts", ".tsx", ".js", ".yml", ".yaml", ".toml", ".sh"}

_SKIP_DIRS = {
    ".git",
    ".venv",
    ".worktrees",
    "node_modules",
    "dist",
    "build",
    "__pycache__",
    ".next",
    ".pytest_cache",
    ".ruff_cache",
    ".terraform",
    "coverage",
    "htmlcov",
}

#: Files exempt from the marker/claim rules, with the reason each is exempt.
_EXEMPT = {
    # The estate's evidence log — a historical record, not guidance.
    "docs/practices",
    "docs/guides/development-practices.md",
    # This guard names the hooks in order to check them.
    "packages/python-sdk/tests/test_lifecycle_hooks_not_invoked.py",
}

#: Where a real invocation could plausibly be introduced: the CLI that ADR-0003
#: says would call the hooks, plus every first-party Python service and package.
#: Tests are excluded — a test calling ``plugin.on_install()`` directly is
#: exercising a method, not evidence that the platform ever does.
_INVOCATION_ROOTS = ("cli/src", "packages", "services", "scripts")


def _repo_root_available() -> bool:
    """True when running from a biffo-template checkout.

    The SDK is published to PyPI and its sdist carries this file, so the
    repo-wide half of the guard can find itself outside the repo entirely. That
    is the only case this concedes; in CI the marker below always exists, so the
    guard cannot quietly skip itself where it matters.
    """
    return (REPO_ROOT / "docs" / "ADR").is_dir() and (REPO_ROOT / "AGENTS.md").is_file()


requires_repo = pytest.mark.skipif(
    not _repo_root_available(),
    reason="repo-wide guard needs a biffo-template checkout (SDK sdist ships this file)",
)


def _is_exempt(relative: str) -> bool:
    return any(relative == entry or relative.startswith(f"{entry}/") for entry in _EXEMPT)


def _text_files() -> list[Path]:
    found: list[Path] = []
    stack = [REPO_ROOT]
    while stack:
        current = stack.pop()
        for child in current.iterdir():
            if child.is_symlink():
                continue
            if child.is_dir():
                if child.name not in _SKIP_DIRS:
                    stack.append(child)
            elif child.suffix in _TEXT_SUFFIXES:
                found.append(child)
    return found


def _files_mentioning_a_hook() -> list[tuple[str, str]]:
    """``(relative path, text)`` for every non-exempt file naming a hook."""
    hits: list[tuple[str, str]] = []
    for path in _text_files():
        relative = path.relative_to(REPO_ROOT).as_posix()
        if _is_exempt(relative):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if _HOOK_RE.search(text):
            hits.append((relative, text))
    return hits


def _sentences(text: str) -> list[str]:
    return [chunk for chunk in re.split(r"[.\n]", text) if chunk.strip()]


class TestTheClaim:
    """No file may say the hooks run, and any file naming them must say they don't."""

    @requires_repo
    def test_every_file_naming_a_hook_says_it_is_not_invoked(self) -> None:
        missing = [
            relative for relative, text in _files_mentioning_a_hook() if not _MARKER_RE.search(text)
        ]
        assert not missing, (
            "These files name on_install/on_uninstall/on_upgrade without saying "
            f"they are {MARKER!r} by anything:\n  " + "\n  ".join(sorted(missing)) + "\n"
            "Every mention is somewhere a plugin author may conclude the hook "
            "fires. Add the words, or stop naming the hook (biffo-template#709)."
        )

    @requires_repo
    def test_no_sentence_asserts_a_hook_is_invoked(self) -> None:
        offenders: list[str] = []
        for relative, text in _files_mentioning_a_hook():
            for sentence in _sentences(text):
                if (
                    _HOOK_RE.search(sentence)
                    and _INVOCATION_RE.search(sentence)
                    and not _NEGATION_RE.search(sentence)
                ):
                    offenders.append(f"{relative}: {sentence.strip()}")
        assert not offenders, (
            "These sentences assert that a lifecycle hook is invoked. Nothing "
            "invokes them (see test_nothing_invokes_the_hooks):\n  " + "\n  ".join(offenders)
        )


class TestTheFact:
    """The hooks really are dead — and this fails loudly on the day they are not."""

    @requires_repo
    def test_nothing_invokes_the_hooks(self) -> None:
        callers: list[str] = []
        for root in _INVOCATION_ROOTS:
            base = REPO_ROOT / root
            if not base.is_dir():
                continue
            for path in base.rglob("*"):
                if not path.is_file() or path.suffix not in _TEXT_SUFFIXES:
                    continue
                parts = set(path.parts)
                if parts & _SKIP_DIRS or "tests" in parts or path.name.startswith("test_"):
                    continue
                relative = path.relative_to(REPO_ROOT).as_posix()
                if _is_exempt(relative):
                    continue
                callers.extend(_hook_calls(path, relative))
        assert not callers, (
            "Something now invokes a plugin lifecycle hook:\n  "
            + "\n  ".join(callers)
            + "\nThat is a real improvement, not a bug — but it makes the rest of "
            "this guard wrong. Update ADR-0003 section 9, the SDK docstrings and "
            "the plugin skeleton to describe what now happens, then delete "
            "TestTheClaim and this assertion."
        )


def _hook_calls(path: Path, relative: str) -> list[str]:
    """Call sites of a hook in *path*.

    Python is parsed, not grepped: a definition (``def on_install``), a
    docstring, or the string ``"on_install"`` in a comment is not a call, and a
    guard that cannot tell those apart fires on its own fix. TypeScript has no
    parser here, so ``cli/`` is matched textually — the CLI referencing the name
    at all is the thing worth knowing about, since ADR-0003 section 9 puts the
    would-be call site precisely there.
    """
    try:
        source = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return []
    if not _HOOK_RE.search(source):
        return []

    if path.suffix != ".py":
        return [f"{relative} (references a hook name)"]

    try:
        tree = ast.parse(source)
    except SyntaxError:  # pragma: no cover - scaffold templates need not parse
        return []

    calls: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = (
            func.attr
            if isinstance(func, ast.Attribute)
            else func.id
            if isinstance(func, ast.Name)
            else None
        )
        if name in HOOKS:
            calls.append(f"{relative}:{node.lineno} calls {name}()")
    return calls


class TestSdkDocstrings:
    """The SDK's own docstrings are the closest documentation to the code."""

    def test_each_hook_docstring_says_it_is_not_invoked(self) -> None:
        tree = ast.parse(SDK_PLUGIN_MODULE.read_text(encoding="utf-8"))
        base = next(
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.ClassDef) and node.name == "BiffoPluginBase"
        )
        methods = {
            node.name: ast.get_docstring(node) or ""
            for node in base.body
            if isinstance(node, ast.FunctionDef)
        }
        for hook in HOOKS:
            assert hook in methods, f"BiffoPluginBase no longer declares {hook}"
            assert _MARKER_RE.search(methods[hook]), (
                f"BiffoPluginBase.{hook}'s docstring must say it is {MARKER!r} — "
                "it is the first thing an author reads on hover."
            )

    def test_class_docstring_says_it_is_not_invoked(self) -> None:
        tree = ast.parse(SDK_PLUGIN_MODULE.read_text(encoding="utf-8"))
        base = next(
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.ClassDef) and node.name == "BiffoPluginBase"
        )
        assert _MARKER_RE.search(ast.get_docstring(base) or "")
