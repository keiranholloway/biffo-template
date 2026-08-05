"""Convention guard: DDL-import modules must be safe to apply twice, and must
resolve unqualified names deterministically.

`biffo data apply` runs each `db/imports/<name>/*.sql` file once and records a
sha256 of its content. If a file's checksum later changes, the next apply
**hard-fails** — "this tool does not support modifying already-applied DDL —
add a new file instead" (`main.py::_run_db_init`).

That guardrail has a consequence that motivates this test: **a module's
idempotency can never be fixed after the fact.** Once a module has been applied
in any environment its text is frozen, and no later module can rescue it —
only the module's own text decides whether re-running it errors. A
non-idempotent module is therefore permanent. The convention has to be enforced
*before* a module first lands, which is what this does.

Why idempotency matters at all, given apply already skips by checksum: the skip
protects the normal path, but not a database whose objects exist while its
`ddl_import_history` does not — a schema-only restore, a truncated history
table, or a chain applied by hand. In those cases the whole import re-runs, and
any non-idempotent module aborts it.

## The second question: does the module resolve names deterministically?

The idempotency checks all ask "is this statement re-appliable?". A module's
`SET search_path` header asks something different, and the two failure modes
are not comparable: a non-idempotent module *errors*, loudly, on the second
apply. A module missing its header does not error at all. Unqualified names
resolve against whatever `search_path` the importer happens to have left set —
and by design it leaves a lot set, because the whole batch runs on one
connection and session state carries forward from earlier files (ADR-0005).

So a header-less module usually **works**, by inheriting a header some earlier
module set. It breaks when the chain is applied in a different order, when the
module is re-applied alone, or when the inherited path simply does not contain
the schema — at which point a bare `fn_authorized()` resolves to nothing, or a
`CREATE TABLE` lands in `public`.

That is not hypothetical. It is the recorded 034 → 035 cost in `tabsii`:
`034_brand_media_soft_delete_rls.sql` called `fn_authorized()` inside a
`CREATE POLICY` with no header, the call could not resolve, the policy errored,
and — because the module's checksum was already recorded and the importer
fail-closes on any edit — it could not be corrected. It needed a whole
successor module, `035_brand_media_soft_delete_rls_fix.sql`, to repair it.

### What "opens with" means, precisely

Leading comments are normal in these modules (most open with a banner), so the
rule cannot be "line 1". It is stated over **statements**, not lines:

> After `--` and `/* */` comments are removed, the module's first SQL statement
> must be a `SET search_path` naming the import's own schema **first** in the
> list.

Three consequences worth being explicit about, because each was a real
candidate for getting this wrong:

- **`CREATE SCHEMA` may precede it, and only `CREATE SCHEMA`.** The bootstrap
  module has to create the schema before it can sensibly select it, and a
  `CREATE SCHEMA <name>` cannot itself resolve an unqualified reference. Any
  other leading statement fails.
- **A `SET search_path` that is a function attribute does not count.** The
  hardened form `CREATE FUNCTION … SET search_path = <schema>, pg_temp AS $$…$$`
  contains the exact substring a naive `grep` would accept, while setting
  nothing at module scope. This is why the check is written over parsed
  statements rather than a regex over the file: 034 would have passed a grep.
- **A module that cannot be parsed FAILS.** A module with no statements at all
  is an error, not a skip. A guard that quietly drops the input it cannot read
  reports the remainder as the whole — the same defect `scripts/protection-
  audit.sh` argues at length, and the reason that audit counts 34 branches
  where it once counted 27.

The schema name is **derived**, never hardcoded: it defaults to the import
directory's own name (`db/imports/acme/` → `acme`), which is the convention
`biffo data import` produces. An import whose directory name is not its schema
says so with the `schema` key below.

## Per-import configuration

Everything instance-specific lives in an **optional** `.ddl-guard.json` beside
the SQL, i.e. `db/imports/<name>/.ddl-guard.json`. `db/` is user-owned, so an
instance's exemptions survive `biffo core upgrade`; this file is template-owned
and carries no instance's data.

```json
{
  "first_guarded_module": "015",
  "schema": "acme",
  "grandfathered_bare_policies": {
    "029_marketplace_brand_profiles.sql": ["bmp_create", "bmp_read"]
  },
  "grandfathered_missing_search_path": ["034_brand_media_soft_delete_rls.sql"]
}
```

- `first_guarded_module` — skip modules whose filename sorts before this. For a
  chain vendored from a pre-existing schema, the early one-shot modules
  (`CREATE TABLE tenants` …) are legitimately not idempotent and were never
  intended to be re-run. Defaults to guarding everything.
- `schema` — the schema this import's modules must select. Defaults to the
  import directory's name.
- `grandfathered_bare_policies` — policy names in a module that is already
  applied somewhere and so can no longer be corrected. Pinned per name, so a
  *new* bare policy in that same file still fails, and a stale entry fails too.
- `grandfathered_missing_search_path` — modules already applied without a
  header, which for the same checksum reason can never gain one. Pinned per
  **filename**: there is no partial credit to give, since a module either opens
  with the header or does not. A new header-less module still fails.

All keys are optional; an absent file means "guard everything, exempt
nothing". Unknown keys and malformed JSON are hard errors rather than being
ignored — an exemption you believe is in force but that silently isn't would be
worse than no guard at all.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import NamedTuple

import pytest
from api.ddl_import import list_sql_files

# services/api/tests/ -> services/api -> services -> <repo root>
REPO_ROOT = Path(__file__).resolve().parents[3]
IMPORTS_ROOT = REPO_ROOT / "db" / "imports"

CONFIG_FILENAME = ".ddl-guard.json"
_KNOWN_CONFIG_KEYS = frozenset(
    {
        "first_guarded_module",
        "schema",
        "grandfathered_bare_policies",
        "grandfathered_missing_search_path",
    }
)


class GuardConfig(NamedTuple):
    """Resolved `.ddl-guard.json` for one import directory."""

    first_guarded_module: str
    schema: str
    grandfathered_bare_policies: dict[str, frozenset[str]]
    grandfathered_missing_search_path: frozenset[str]
    source: Path | None


class GuardedModule(NamedTuple):
    """One SQL module plus the config governing it."""

    path: Path
    config: GuardConfig


def _load_config(import_dir: Path) -> GuardConfig:
    """Read `.ddl-guard.json`, or return permissive-to-nobody defaults."""
    config_path = import_dir / CONFIG_FILENAME
    if not config_path.is_file():
        return GuardConfig("", "", {}, frozenset(), None)

    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{config_path} is not valid JSON: {exc}") from exc

    if not isinstance(raw, dict):
        raise ValueError(f"{config_path} must contain a JSON object, got {type(raw).__name__}")

    unknown = set(raw) - _KNOWN_CONFIG_KEYS
    if unknown:
        raise ValueError(
            f"{config_path} has unknown key(s) {sorted(unknown)}; "
            f"expected any of {sorted(_KNOWN_CONFIG_KEYS)}. "
            "Refusing to continue — a misspelled key would silently drop an exemption."
        )

    first = raw.get("first_guarded_module", "")
    if not isinstance(first, str):
        raise ValueError(f"{config_path}: 'first_guarded_module' must be a string")

    schema = raw.get("schema", "")
    if not isinstance(schema, str):
        raise ValueError(f"{config_path}: 'schema' must be a string")

    missing_header_raw = raw.get("grandfathered_missing_search_path", [])
    if not isinstance(missing_header_raw, list) or not all(
        isinstance(n, str) for n in missing_header_raw
    ):
        raise ValueError(
            f"{config_path}: 'grandfathered_missing_search_path' must be a list of "
            "module-filename strings"
        )

    exemptions_raw = raw.get("grandfathered_bare_policies", {})
    if not isinstance(exemptions_raw, dict):
        raise ValueError(f"{config_path}: 'grandfathered_bare_policies' must be an object")

    exemptions: dict[str, frozenset[str]] = {}
    for filename, names in exemptions_raw.items():
        if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
            raise ValueError(
                f"{config_path}: 'grandfathered_bare_policies[{filename!r}]' "
                "must be a list of policy-name strings"
            )
        exemptions[filename] = frozenset(names)

    return GuardConfig(first, schema, exemptions, frozenset(missing_header_raw), config_path)


def _discover() -> list[GuardedModule]:
    """Every module the importer would apply, paired with its guard config."""
    if not IMPORTS_ROOT.is_dir():
        return []

    modules: list[GuardedModule] = []
    for import_dir in sorted(IMPORTS_ROOT.iterdir()):
        if not import_dir.is_dir():
            continue
        config = _load_config(import_dir)
        for path in list_sql_files(import_dir):
            if path.name >= config.first_guarded_module:
                modules.append(GuardedModule(path, config))
    return modules


MODULES = _discover()


def _module_id(module: GuardedModule) -> str:
    return f"{module.path.parent.name}/{module.path.name}"


def _strip_sql_comments(sql: str) -> str:
    """Drop `--` line and `/* */` block comments before scanning.

    Without this the scan matches prose: a module header explaining that "the
    CREATE POLICY errored" is not a CREATE POLICY statement.
    """
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    return re.sub(r"--[^\n]*", " ", sql)


def _read(module: GuardedModule) -> str:
    return _strip_sql_comments(module.path.read_text(encoding="utf-8"))


# --- search_path header detection -------------------------------------------
#
# Written over parsed statements rather than a regex over the file, because the
# statement boundary is the whole point: `CREATE FUNCTION … SET search_path =
# tabsii, pg_temp AS $$…$$` contains the substring a regex would accept while
# setting nothing at module scope. See the module docstring.

_DOLLAR_TAG = re.compile(r"\$[A-Za-z_]\w*\$|\$\$")
_CREATE_SCHEMA = re.compile(r"^CREATE\s+SCHEMA\b", re.IGNORECASE)
_SET_SEARCH_PATH = re.compile(
    r"^SET\s+(?:SESSION\s+|LOCAL\s+)?search_path\s*(?:=|\bTO\b)\s*(.+)$",
    re.IGNORECASE | re.DOTALL,
)


def _iter_statements(sql: str):
    """Yield top-level statements, respecting dollar-quoting and '' literals.

    Both forms genuinely occur and both hide semicolons that are not statement
    terminators: PL/pgSQL bodies (`$$ … ; … $$`) and string literals seeded by
    dev-data modules. Splitting naively on `;` would cut a function body into
    fragments and mistake the first fragment for the module's first statement.
    """
    buf: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "'":
            j = i + 1
            while j < n:
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":  # doubled = escaped quote
                        j += 2
                        continue
                    break
                j += 1
            buf.append(sql[i : j + 1])
            i = j + 1
            continue
        tag_match = _DOLLAR_TAG.match(sql, i)
        if tag_match:
            tag = tag_match.group(0)
            end = sql.find(tag, tag_match.end())
            end = n if end == -1 else end + len(tag)
            buf.append(sql[i:end])
            i = end
            continue
        if ch == ";":
            statement = "".join(buf).strip()
            if statement:
                yield statement
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    trailing = "".join(buf).strip()
    if trailing:  # a final statement with no terminating semicolon
        yield trailing


def _expected_schema(module: GuardedModule) -> str:
    """The schema this module must select — derived, never hardcoded."""
    return module.config.schema or module.path.parent.name


def _header_schema(sql: str) -> tuple[str | None, str]:
    """`(schema, reason)` for the module's opening `SET search_path`.

    `schema` is `None` when the module has no such header, in which case
    `reason` says why — never silently "no opinion".
    """
    for statement in _iter_statements(_strip_sql_comments(sql)):
        if _CREATE_SCHEMA.match(statement):
            continue  # the bootstrap module must create the schema first
        match = _SET_SEARCH_PATH.match(statement)
        if not match:
            excerpt = " ".join(statement.split())[:70]
            return None, f"its first statement is `{excerpt}`"
        selected = match.group(1).split(",")[0].strip().strip("'\"")
        return selected, ""
    return None, "it contains no SQL statements at all"


@pytest.mark.skipif(not MODULES, reason="no DDL imports vendored in this repo")
@pytest.mark.parametrize("module", MODULES, ids=_module_id)
class TestDdlImportIdempotency:
    """Mechanical checks for the ways a module fails on a second apply.

    Deliberately not a general "is this SQL idempotent" analysis — these cover
    the statements that actually recur in DDL-import modules and have no
    `IF NOT EXISTS` form or are easy to write without one.
    """

    def test_create_policy_is_guarded(self, module: GuardedModule) -> None:
        """`CREATE POLICY x` needs `DROP POLICY IF EXISTS x` or a catalog check.

        Postgres has no `CREATE POLICY IF NOT EXISTS`, so a bare `CREATE POLICY`
        raises "policy ... already exists" on re-apply. Two guard styles are
        accepted: drop-then-create, and wrapping the create in
        `IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = '...')`.
        """
        sql = _read(module)

        created = re.findall(r"\bCREATE\s+POLICY\s+(\w+)", sql, re.IGNORECASE)
        if not created:
            pytest.skip("module creates no policies")

        dropped = {
            name.lower()
            for name in re.findall(r"\bDROP\s+POLICY\s+IF\s+EXISTS\s+(\w+)", sql, re.IGNORECASE)
        }
        catalog_guarded = {
            name.lower() for name in re.findall(r"policyname\s*=\s*'(\w+)'", sql, re.IGNORECASE)
        }
        guarded = dropped | catalog_guarded

        allowed = module.config.grandfathered_bare_policies.get(module.path.name, frozenset())
        unguarded = {name for name in created if name.lower() not in guarded} - allowed

        assert not unguarded, (
            f"{_module_id(module)} creates {sorted(unguarded)} with no "
            "DROP POLICY IF EXISTS and no pg_policies existence check, so "
            "re-applying this module errors.\n\n"
            "Postgres has no CREATE POLICY IF NOT EXISTS — precede each "
            "CREATE POLICY with DROP POLICY IF EXISTS <name>.\n\n"
            "Fix this BEFORE the module is first applied anywhere: once applied, "
            "its checksum is recorded and the importer refuses any edit to it, "
            "making the module permanently non-idempotent. If that has already "
            "happened, record it in "
            f"{module.path.parent / CONFIG_FILENAME} under "
            "'grandfathered_bare_policies'."
        )

    def test_create_table_is_guarded(self, module: GuardedModule) -> None:
        """`CREATE TABLE` must be `IF NOT EXISTS`, or preceded by a DROP."""
        sql = _read(module)

        bare = re.findall(r"\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)([\w.]+)", sql, re.IGNORECASE)
        dropped = {
            name.lower()
            for name in re.findall(r"\bDROP\s+TABLE\s+IF\s+EXISTS\s+([\w.]+)", sql, re.IGNORECASE)
        }
        unguarded = sorted({name for name in bare if name.lower() not in dropped})

        assert not unguarded, (
            f"{_module_id(module)} has CREATE TABLE without IF NOT EXISTS for "
            f"{unguarded} — re-applying this module errors."
        )

    def test_create_index_is_guarded(self, module: GuardedModule) -> None:
        """`CREATE INDEX` must be `IF NOT EXISTS`."""
        sql = _read(module)

        bare = sorted(
            set(
                re.findall(
                    r"\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+"
                    r"(?!IF\s+NOT\s+EXISTS|CONCURRENTLY)(\w+)",
                    sql,
                    re.IGNORECASE,
                )
            )
        )

        assert not bare, (
            f"{_module_id(module)} has CREATE INDEX without IF NOT EXISTS for "
            f"{bare} — re-applying this module errors."
        )

    def test_add_column_is_guarded(self, module: GuardedModule) -> None:
        """`ALTER TABLE ... ADD COLUMN` must be `IF NOT EXISTS`."""
        sql = _read(module)

        bare = sorted(
            set(re.findall(r"\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)(\w+)", sql, re.IGNORECASE))
        )

        assert not bare, (
            f"{_module_id(module)} has ADD COLUMN without IF NOT EXISTS for "
            f"{bare} — re-applying this module errors."
        )


@pytest.mark.skipif(not MODULES, reason="no DDL imports vendored in this repo")
@pytest.mark.parametrize("module", MODULES, ids=_module_id)
class TestDdlImportNameResolution:
    """Every module must select its own schema before it does anything else.

    Deliberately a separate class from the idempotency checks: those ask "does
    this error on a second apply?", this asks "does this resolve unqualified
    names deterministically?". The second failure mode is silent, which makes
    it the cheaper one to introduce and — once the module's checksum is
    recorded — the more expensive one to recover from.
    """

    def test_opens_with_set_search_path(self, module: GuardedModule) -> None:
        """The first statement must be `SET search_path TO <schema>, …`."""
        expected = _expected_schema(module)
        selected, reason = _header_schema(module.path.read_text(encoding="utf-8"))

        grandfathered = module.path.name in module.config.grandfathered_missing_search_path
        if selected is None and grandfathered:
            pytest.skip(f"grandfathered in {CONFIG_FILENAME}: applied without a header")

        assert selected is not None, (
            f"{_module_id(module)} does not open with a SET search_path header — "
            f"{reason}.\n\n"
            f"Add `SET search_path TO {expected}, public;` as the module's first "
            "statement, after the banner comment. Without it, every unqualified "
            "name in this module resolves against whatever search_path an earlier "
            "module happened to leave set on the shared connection — so the module "
            "may apply cleanly today and create objects in the wrong schema, or "
            "fail to resolve a bare function call, when the chain is applied in a "
            "different order or re-applied alone.\n\n"
            "Fix this BEFORE the module is first applied anywhere: once applied, "
            "its checksum is recorded and the importer refuses any edit to it, so "
            "the repair costs a whole successor module. If that has already "
            f"happened, record it in {module.path.parent / CONFIG_FILENAME} under "
            "'grandfathered_missing_search_path'."
        )

        assert selected == expected, (
            f"{_module_id(module)} opens with a SET search_path that selects "
            f"{selected!r} first, but this import's schema is {expected!r}.\n\n"
            "The import's own schema must come first in the list, or unqualified "
            f"names resolve into {selected!r} instead. Expected "
            f"`SET search_path TO {expected}, public;`.\n\n"
            f"If {expected!r} is genuinely the wrong name for this import, set "
            f"'schema' in {module.path.parent / CONFIG_FILENAME} — it defaults to "
            "the import directory's name."
        )


@pytest.mark.skipif(not MODULES, reason="no DDL imports vendored in this repo")
class TestGuardConfigHygiene:
    """A stale or over-broad exemption list is itself a defect."""

    def test_exemptions_reference_existing_modules(self) -> None:
        """Every exempted filename must still be present in its import."""
        stale: list[str] = []
        for import_dir in sorted(p for p in IMPORTS_ROOT.iterdir() if p.is_dir()):
            config = _load_config(import_dir)
            if not config.grandfathered_bare_policies:
                continue
            present = {path.name for path in list_sql_files(import_dir)}
            stale += [
                f"{import_dir.name}/{filename}"
                for filename in config.grandfathered_bare_policies
                if filename not in present
            ]

        assert not stale, (
            f"{CONFIG_FILENAME} exempts modules that no longer exist: {sorted(stale)}. "
            "Remove them so the exemption list cannot drift into a blanket opt-out."
        )

    def test_exempted_policies_are_still_created(self) -> None:
        """Every exempted policy name must still appear in its module.

        Stops an exemption outliving the statement it excused — otherwise the
        entry silently starts covering nothing, or worse, a future rename.
        """
        stale: list[str] = []
        for import_dir in sorted(p for p in IMPORTS_ROOT.iterdir() if p.is_dir()):
            config = _load_config(import_dir)
            for filename, names in config.grandfathered_bare_policies.items():
                path = import_dir / filename
                if not path.is_file():
                    continue  # covered by the test above
                sql = _strip_sql_comments(path.read_text(encoding="utf-8"))
                created = {
                    name.lower()
                    for name in re.findall(r"\bCREATE\s+POLICY\s+(\w+)", sql, re.IGNORECASE)
                }
                stale += [
                    f"{import_dir.name}/{filename}:{name}"
                    for name in sorted(names)
                    if name.lower() not in created
                ]

        assert not stale, (
            f"{CONFIG_FILENAME} exempts policies that are no longer created: "
            f"{sorted(stale)}. Remove them."
        )

    def test_search_path_exemptions_reference_existing_modules(self) -> None:
        """A header exemption naming a module that is gone must be removed."""
        stale: list[str] = []
        for import_dir in sorted(p for p in IMPORTS_ROOT.iterdir() if p.is_dir()):
            config = _load_config(import_dir)
            if not config.grandfathered_missing_search_path:
                continue
            present = {path.name for path in list_sql_files(import_dir)}
            stale += [
                f"{import_dir.name}/{filename}"
                for filename in config.grandfathered_missing_search_path
                if filename not in present
            ]

        assert not stale, (
            f"{CONFIG_FILENAME} exempts modules that no longer exist: {sorted(stale)}. "
            "Remove them so the exemption list cannot drift into a blanket opt-out."
        )

    def test_search_path_exemptions_are_still_needed(self) -> None:
        """A module that *does* open with the header must not be exempted.

        This is what makes the residue ratchet down instead of being blessed:
        an entry that stops being necessary has to be deleted, so the list can
        only ever shrink.
        """
        unnecessary: list[str] = []
        for import_dir in sorted(p for p in IMPORTS_ROOT.iterdir() if p.is_dir()):
            config = _load_config(import_dir)
            for filename in config.grandfathered_missing_search_path:
                path = import_dir / filename
                if not path.is_file():
                    continue  # covered by the test above
                selected, _ = _header_schema(path.read_text(encoding="utf-8"))
                if selected is not None:
                    unnecessary.append(f"{import_dir.name}/{filename}")

        assert not unnecessary, (
            f"{CONFIG_FILENAME} exempts modules that now open with a SET "
            f"search_path header: {sorted(unnecessary)}. Remove them — a "
            "ratchet that never tightens stops meaning anything."
        )


# ---------------------------------------------------------------------------
# Unit tests for the guard itself.
#
# The checks above are inert in this repo — the template vendors no DDL imports,
# so they skip. Without the tests below, this file would ship to every instance
# having never executed. These exercise the detection and config logic directly
# against synthetic modules.
# ---------------------------------------------------------------------------


def _write_module(import_dir: Path, name: str, sql: str) -> GuardedModule:
    import_dir.mkdir(parents=True, exist_ok=True)
    path = import_dir / name
    path.write_text(sql, encoding="utf-8")
    return GuardedModule(path, _load_config(import_dir))


@pytest.fixture
def checks() -> TestDdlImportIdempotency:
    return TestDdlImportIdempotency()


class TestPolicyDetection:
    def test_bare_create_policy_fails(self, tmp_path, checks) -> None:
        module = _write_module(
            tmp_path / "demo",
            "010_x.sql",
            "CREATE POLICY p_read ON t FOR SELECT USING (true);",
        )
        with pytest.raises(AssertionError, match="p_read"):
            checks.test_create_policy_is_guarded(module)

    def test_drop_then_create_passes(self, tmp_path, checks) -> None:
        module = _write_module(
            tmp_path / "demo",
            "010_x.sql",
            "DROP POLICY IF EXISTS p_read ON t;\n"
            "CREATE POLICY p_read ON t FOR SELECT USING (true);",
        )
        checks.test_create_policy_is_guarded(module)

    def test_pg_policies_existence_check_passes(self, tmp_path, checks) -> None:
        """The `DO $$ IF NOT EXISTS (SELECT 1 FROM pg_policies ...)` style."""
        module = _write_module(
            tmp_path / "demo",
            "010_x.sql",
            "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies "
            "WHERE policyname = 'p_read') THEN "
            "CREATE POLICY p_read ON t FOR SELECT USING (true); END IF; END $$;",
        )
        checks.test_create_policy_is_guarded(module)

    def test_policy_named_only_in_a_comment_is_not_a_statement(self, tmp_path, checks) -> None:
        """Prose must not be mistaken for SQL.

        Asserted via the skip outcome, which is what "this module creates no
        policies" means. `pytest.skip` raises `Skipped`, a BaseException — so
        this must catch `pytest.skip.Exception` explicitly; `pytest.raises(
        Exception)` would let it through and silently skip this test instead.
        """
        module = _write_module(
            tmp_path / "demo",
            "010_x.sql",
            "-- An earlier module's CREATE POLICY errored here.\nSELECT 1;",
        )
        with pytest.raises(pytest.skip.Exception):
            checks.test_create_policy_is_guarded(module)

    def test_strip_sql_comments_removes_both_comment_forms(self) -> None:
        stripped = _strip_sql_comments(
            "-- line CREATE POLICY a\n/* block CREATE POLICY b */\nCREATE POLICY c ON t;"
        )
        assert "a" not in stripped and "b" not in stripped
        assert "CREATE POLICY c" in stripped

    def test_comment_does_not_satisfy_the_guard(self, tmp_path, checks) -> None:
        """A DROP mentioned only in a comment must not count as guarding."""
        module = _write_module(
            tmp_path / "demo",
            "010_x.sql",
            "-- DROP POLICY IF EXISTS p_read ON t;\n"
            "CREATE POLICY p_read ON t FOR SELECT USING (true);",
        )
        with pytest.raises(AssertionError, match="p_read"):
            checks.test_create_policy_is_guarded(module)

    def test_grandfathered_policy_is_exempt(self, tmp_path, checks) -> None:
        import_dir = tmp_path / "demo"
        import_dir.mkdir()
        (import_dir / CONFIG_FILENAME).write_text(
            json.dumps({"grandfathered_bare_policies": {"010_x.sql": ["p_read"]}}),
            encoding="utf-8",
        )
        module = _write_module(
            import_dir, "010_x.sql", "CREATE POLICY p_read ON t FOR SELECT USING (true);"
        )
        checks.test_create_policy_is_guarded(module)

    def test_exemption_does_not_cover_a_new_policy(self, tmp_path, checks) -> None:
        """The pinned list must not become a blanket opt-out for the file."""
        import_dir = tmp_path / "demo"
        import_dir.mkdir()
        (import_dir / CONFIG_FILENAME).write_text(
            json.dumps({"grandfathered_bare_policies": {"010_x.sql": ["p_read"]}}),
            encoding="utf-8",
        )
        module = _write_module(
            import_dir,
            "010_x.sql",
            "CREATE POLICY p_read ON t FOR SELECT USING (true);\n"
            "CREATE POLICY p_write ON t FOR INSERT WITH CHECK (true);",
        )
        with pytest.raises(AssertionError, match="p_write"):
            checks.test_create_policy_is_guarded(module)


class TestStatementDetection:
    @pytest.mark.parametrize(
        ("sql", "check_name", "needle"),
        [
            ("CREATE TABLE t (id int);", "test_create_table_is_guarded", "t"),
            ("CREATE INDEX ix_t ON t(id);", "test_create_index_is_guarded", "ix_t"),
            ("CREATE UNIQUE INDEX ux_t ON t(id);", "test_create_index_is_guarded", "ux_t"),
            ("ALTER TABLE t ADD COLUMN c text;", "test_add_column_is_guarded", "c"),
        ],
    )
    def test_bare_statement_fails(
        self, tmp_path, checks, sql: str, check_name: str, needle: str
    ) -> None:
        module = _write_module(tmp_path / "demo", "010_x.sql", sql)
        with pytest.raises(AssertionError, match=needle):
            getattr(checks, check_name)(module)

    @pytest.mark.parametrize(
        ("sql", "check_name"),
        [
            ("CREATE TABLE IF NOT EXISTS t (id int);", "test_create_table_is_guarded"),
            ("DROP TABLE IF EXISTS t;\nCREATE TABLE t (id int);", "test_create_table_is_guarded"),
            ("CREATE INDEX IF NOT EXISTS ix_t ON t(id);", "test_create_index_is_guarded"),
            ("ALTER TABLE t ADD COLUMN IF NOT EXISTS c text;", "test_add_column_is_guarded"),
        ],
    )
    def test_guarded_statement_passes(self, tmp_path, checks, sql: str, check_name: str) -> None:
        module = _write_module(tmp_path / "demo", "010_x.sql", sql)
        getattr(checks, check_name)(module)


@pytest.fixture
def header_checks() -> TestDdlImportNameResolution:
    return TestDdlImportNameResolution()


class TestSearchPathHeaderDetection:
    """The 034 class: a module that resolves names off inherited session state."""

    def test_module_with_no_header_fails(self, tmp_path, header_checks) -> None:
        module = _write_module(
            tmp_path / "demo",
            "010_x.sql",
            "DROP POLICY IF EXISTS p ON demo.t;\n"
            "CREATE POLICY p ON demo.t FOR SELECT USING (fn_authorized('x'));",
        )
        with pytest.raises(AssertionError, match="does not open with a SET search_path"):
            header_checks.test_opens_with_set_search_path(module)

    def test_header_as_first_statement_passes(self, tmp_path, header_checks) -> None:
        module = _write_module(
            tmp_path / "demo",
            "010_x.sql",
            "SET search_path TO demo, public;\nSELECT 1;",
        )
        header_checks.test_opens_with_set_search_path(module)

    def test_banner_comment_before_the_header_is_fine(self, tmp_path, header_checks) -> None:
        """ "Opens with" is about statements, not line 1 — banners are normal."""
        module = _write_module(
            tmp_path / "demo",
            "010_x.sql",
            "-- ============================================\n"
            "-- Module 010: something\n"
            "-- ============================================\n"
            "\n"
            "SET search_path TO demo, public;\nSELECT 1;",
        )
        header_checks.test_opens_with_set_search_path(module)

    def test_create_schema_may_precede_the_header(self, tmp_path, header_checks) -> None:
        """The bootstrap module creates the schema before selecting it."""
        module = _write_module(
            tmp_path / "demo",
            "010_x.sql",
            "CREATE SCHEMA IF NOT EXISTS demo;\nSET search_path TO demo, public;",
        )
        header_checks.test_opens_with_set_search_path(module)

    def test_function_attribute_search_path_does_not_count(self, tmp_path, header_checks) -> None:
        """The exact shape a grep-based guard would have waved through.

        `CREATE FUNCTION … SET search_path = demo, pg_temp` sets the path for
        that function's own body and nothing else, so the module's remaining
        statements still resolve against inherited state.
        """
        module = _write_module(
            tmp_path / "demo",
            "010_x.sql",
            "CREATE FUNCTION f() RETURNS int LANGUAGE sql "
            "SET search_path = demo, pg_temp AS $$ SELECT 1; $$;",
        )
        with pytest.raises(AssertionError, match="does not open with a SET search_path"):
            header_checks.test_opens_with_set_search_path(module)

    def test_header_in_a_comment_does_not_count(self, tmp_path, header_checks) -> None:
        module = _write_module(
            tmp_path / "demo",
            "010_x.sql",
            "-- SET search_path TO demo, public;\nSELECT 1;",
        )
        with pytest.raises(AssertionError, match="does not open with a SET search_path"):
            header_checks.test_opens_with_set_search_path(module)

    def test_unparseable_module_fails_rather_than_skipping(self, tmp_path, header_checks) -> None:
        """A module with no statements is an error, not an absence of opinion."""
        module = _write_module(tmp_path / "demo", "010_x.sql", "-- just a comment\n\n")
        with pytest.raises(AssertionError, match="no SQL statements at all"):
            header_checks.test_opens_with_set_search_path(module)

    def test_wrong_schema_first_in_the_list_fails(self, tmp_path, header_checks) -> None:
        module = _write_module(tmp_path / "demo", "010_x.sql", "SET search_path TO public, demo;")
        with pytest.raises(AssertionError, match="selects 'public' first"):
            header_checks.test_opens_with_set_search_path(module)

    @pytest.mark.parametrize(
        "header",
        [
            "SET search_path TO demo, public;",
            "SET search_path = demo, public;",
            "SET search_path TO 'demo', 'pg_temp';",
            "set search_path to demo;",
        ],
    )
    def test_accepted_header_spellings(self, tmp_path, header_checks, header: str) -> None:
        module = _write_module(tmp_path / "demo", "010_x.sql", f"{header}\nSELECT 1;")
        header_checks.test_opens_with_set_search_path(module)

    def test_schema_defaults_to_the_import_directory_name(self, tmp_path) -> None:
        """Derived, not hardcoded — an instance's schema is not `tabsii`."""
        module = _write_module(tmp_path / "acme", "010_x.sql", "SET search_path TO acme;")
        assert _expected_schema(module) == "acme"

    def test_schema_key_overrides_the_directory_name(self, tmp_path, header_checks) -> None:
        import_dir = tmp_path / "vendored"
        import_dir.mkdir()
        (import_dir / CONFIG_FILENAME).write_text(json.dumps({"schema": "acme"}), encoding="utf-8")
        module = _write_module(import_dir, "010_x.sql", "SET search_path TO acme, public;")
        assert _expected_schema(module) == "acme"
        header_checks.test_opens_with_set_search_path(module)

    def test_grandfathered_module_is_exempt(self, tmp_path, header_checks) -> None:
        import_dir = tmp_path / "demo"
        import_dir.mkdir()
        (import_dir / CONFIG_FILENAME).write_text(
            json.dumps({"grandfathered_missing_search_path": ["010_x.sql"]}),
            encoding="utf-8",
        )
        module = _write_module(import_dir, "010_x.sql", "SELECT 1;")
        with pytest.raises(pytest.skip.Exception):
            header_checks.test_opens_with_set_search_path(module)

    def test_exemption_does_not_cover_a_different_module(self, tmp_path, header_checks) -> None:
        """Pinned per filename, so a NEW header-less module still fails."""
        import_dir = tmp_path / "demo"
        import_dir.mkdir()
        (import_dir / CONFIG_FILENAME).write_text(
            json.dumps({"grandfathered_missing_search_path": ["010_x.sql"]}),
            encoding="utf-8",
        )
        module = _write_module(import_dir, "011_y.sql", "SELECT 1;")
        with pytest.raises(AssertionError, match="011_y.sql"):
            header_checks.test_opens_with_set_search_path(module)


class TestStatementSplitting:
    """Semicolons inside bodies and literals are not statement boundaries."""

    def test_dollar_quoted_body_is_one_statement(self) -> None:
        statements = list(_iter_statements("DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;\nSELECT 3;"))
        assert len(statements) == 2
        assert statements[0].startswith("DO $$")
        assert statements[1] == "SELECT 3"

    def test_tagged_dollar_quote_is_one_statement(self) -> None:
        statements = list(_iter_statements("CREATE FUNCTION f() AS $body$ SELECT 1; $body$;"))
        assert len(statements) == 1

    def test_semicolon_inside_a_string_literal_is_not_a_boundary(self) -> None:
        statements = list(_iter_statements("INSERT INTO t VALUES ('a;b');\nSELECT 1;"))
        assert len(statements) == 2
        assert statements[0].endswith("('a;b')")

    def test_escaped_quote_inside_a_literal(self) -> None:
        statements = list(_iter_statements("SELECT 'it''s; fine';\nSELECT 2;"))
        assert len(statements) == 2

    def test_final_statement_without_a_semicolon_is_yielded(self) -> None:
        assert list(_iter_statements("SELECT 1")) == ["SELECT 1"]

    def test_blank_input_yields_nothing(self) -> None:
        assert list(_iter_statements("   \n\n  ")) == []


class TestConfigLoading:
    def test_absent_config_guards_everything(self, tmp_path) -> None:
        (tmp_path / "demo").mkdir()
        config = _load_config(tmp_path / "demo")
        assert config.first_guarded_module == ""
        assert config.schema == ""
        assert config.grandfathered_bare_policies == {}
        assert config.grandfathered_missing_search_path == frozenset()
        assert config.source is None

    def test_wrong_search_path_exemption_shape_is_a_hard_error(self, tmp_path) -> None:
        import_dir = tmp_path / "demo"
        import_dir.mkdir()
        (import_dir / CONFIG_FILENAME).write_text(
            json.dumps({"grandfathered_missing_search_path": "010_x.sql"}),
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="list of module-filename strings"):
            _load_config(import_dir)

    def test_first_guarded_module_is_a_filename_bound(self, tmp_path) -> None:
        """Modules sorting before the bound are out of scope."""
        import_dir = tmp_path / "demo"
        import_dir.mkdir()
        (import_dir / CONFIG_FILENAME).write_text(
            json.dumps({"first_guarded_module": "015"}), encoding="utf-8"
        )
        config = _load_config(import_dir)
        assert "014_legacy.sql" < config.first_guarded_module
        assert "015_first.sql" >= config.first_guarded_module

    def test_malformed_json_is_a_hard_error(self, tmp_path) -> None:
        import_dir = tmp_path / "demo"
        import_dir.mkdir()
        (import_dir / CONFIG_FILENAME).write_text("{not json", encoding="utf-8")
        with pytest.raises(ValueError, match="not valid JSON"):
            _load_config(import_dir)

    def test_unknown_key_is_a_hard_error(self, tmp_path) -> None:
        """A typo must not silently drop an exemption the author believes is live."""
        import_dir = tmp_path / "demo"
        import_dir.mkdir()
        (import_dir / CONFIG_FILENAME).write_text(
            json.dumps({"grandfathered_policies": {}}), encoding="utf-8"
        )
        with pytest.raises(ValueError, match="unknown key"):
            _load_config(import_dir)

    def test_wrong_exemption_shape_is_a_hard_error(self, tmp_path) -> None:
        import_dir = tmp_path / "demo"
        import_dir.mkdir()
        (import_dir / CONFIG_FILENAME).write_text(
            json.dumps({"grandfathered_bare_policies": {"010_x.sql": "p_read"}}),
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="list of policy-name strings"):
            _load_config(import_dir)
