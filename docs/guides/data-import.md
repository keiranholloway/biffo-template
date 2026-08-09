# Guide: Importing a DDL Data Model (`biffo data`)

`biffo data` loads a directory of hand-written PostgreSQL `.sql` files — schemas, tables, triggers, RLS policies, seed data — into your deployment's database. It's built for the case where your data model was designed outside the Core API's own Alembic migrations (for example, in a separate data-modelling repo) and you need to bring it into a Biffo project without hand-converting every statement into a migration.

For the design rationale (why it works this way, not how to use it), see [ADR-0005](../ADR/0005-ddl-import-module.md).

## The three commands

| Command                                           | What it does                                               |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `biffo data import <name> --source <path-or-url>` | Copies `.sql` files into your repo and commits them        |
| `biffo data apply <name> --env <environment>`     | Runs those files against a deployed environment's database |
| `biffo data list`                                 | Shows what's been imported locally                         |

`import` never touches a live database, and `apply` never touches your local files — the two are deliberately separate steps, same as `git push` and a deploy are separate.

## 1. Import a directory of `.sql` files

Run this from the root of your Biffo project checkout (where `services/` and `db/` live).

**From a local directory:**

```bash
biffo data import tabsii --source /path/to/tabsii-data-model-design/ddl/modules
```

**From a GitHub repo:**

```bash
biffo data import tabsii --source https://github.com/your-org/data-model-design --path ddl/modules
```

- `<name>` is a lowercase, hyphenated slug (e.g. `tabsii`, `crm-schema`) — it becomes the directory name under `db/imports/<name>/` and the identifier you pass to `biffo data apply`.
- `--source` is either an existing local directory, or a git URL. Whichever it is, only the `.sql` files directly inside it (or inside `--path`, if given) are copied — not the whole repository, and not subdirectories.
- `--path` is optional: use it when the `.sql` files live in a subdirectory of the source (local or cloned), e.g. `ddl/modules` in the example above.
- `--dry-run` resolves the source and prints what would be copied, without writing or committing anything.

What happens: the CLI copies the matching `.sql` files into `db/imports/<name>/` in your working tree, then runs `git add` + `git commit` for you (message: `feat(data): import <name> (<N> SQL file(s))`). It does **not** run `git push`, and it does not touch any deployed environment. You push and deploy when you're ready, same as any other change.

**File naming matters.** Files are applied in filename-sorted order, so number your DDL files so alphabetical order matches execution order — `000_schema_setup.sql`, `001_tables.sql`, `002_indexes.sql`, and so on. If any file doesn't start with a digit, `import` prints a warning (it still imports the file — the warning is just telling you its position in the apply order might not be what you expect).

### Private repositories

If `--source` is a private GitHub repo, the CLI needs a token to clone it. It resolves one automatically, in this order:

1. `--token <pat>` passed explicitly on the command line
2. the `BIFFO_DATA_IMPORT_TOKEN` environment variable
3. `gh auth token`, if you have the GitHub CLI installed and logged in
4. an interactive password-masked prompt, as a last resort

The token is never written to `biffo.config.json`, never logged, and never appears in an error message.

## 2. Deploy it

`db/imports/<name>/*.sql` is a normal part of your repo now — push it, and your existing CI/CD pipeline picks it up like anything else:

```bash
git push
biffo deploy <environment> --app-only
```

The deploy bundles the `.sql` files into the Core API Lambda's deployment package. Nothing runs against the database yet — that's the next step.

## 3. Apply it to a database

```bash
biffo data apply tabsii --env dev
```

This invokes the deployed Core API Lambda directly and asks it to run `db/imports/tabsii/`'s files against that environment's real database, in filename order. You'll see a report of what happened:

```
  DDL import 'tabsii' applied to dev

  Applied (13):
    + 000_schema_setup.sql
    + 001_identity_core.sql
    ...
```

- `-p, --project <name>` / `-c, --config <path>` let you target a specific project if you have more than one `biffo.config.json` saved locally, or aren't running from inside the project checkout.
- `--env` is required and must be `dev`, `staging`, or `prod`.

### Re-running is always safe

`biffo data apply` tracks what's been applied by content checksum, per file. Run it again after nothing has changed and every file reports as skipped, not re-applied:

```
  DDL import 'tabsii' applied to dev

  Already applied, unchanged — skipped (13):
    = 000_schema_setup.sql
    = 001_identity_core.sql
    ...
```

### Adding more DDL later

`biffo data import <name>` refuses to run again once `db/imports/<name>/` already exists — you'll get an "already present" error telling you to remove it first. To add new statements to an existing import, add a **new** numbered file (e.g. `013_more_tables.sql`) directly under `db/imports/<name>/` and commit it yourself. Push and `biffo data apply` again; only the new file shows up under "Applied", everything else stays "skipped".

### If an already-applied file changes

This tool does not support silently re-running a file that's already been applied — that's a correctness guardrail, not a missing feature. If you edit a file under `db/imports/<name>/` that a previous `apply` already ran, the next `apply` hard-fails instead of guessing what to do:

```
✘ DDL import 'tabsii' failed: DDL file '012_permission_catalog.sql' in import
'tabsii' has changed since it was applied (checksum f44b48... -> 4a999c...).
This tool does not support modifying already-applied DDL — add a new file
instead.
```

Nothing else in the batch is touched when this happens — the whole `apply` run stops cleanly at that point. If you genuinely need to change already-applied DDL, write a new file that alters what the old one created (e.g. `013_fix_permission_catalog.sql` with an `ALTER TABLE`/`UPDATE`), rather than editing the original.

### Write every file so it can run twice

The checksum-skip above protects the normal path, but it is not the whole story. A database can have the objects while its `ddl_import_history` does not agree — a schema-only restore, a truncated history table, a chain applied by hand. Then the whole import re-runs, and any file that can't tolerate that aborts it.

So every file should be idempotent:

```sql
CREATE TABLE IF NOT EXISTS tabsii.thing (...);
CREATE INDEX IF NOT EXISTS ix_thing ON tabsii.thing(id);
ALTER TABLE tabsii.thing ADD COLUMN IF NOT EXISTS note text;
INSERT INTO tabsii.thing (...) VALUES (...) ON CONFLICT DO NOTHING;
```

Policies are the trap, because **Postgres has no `CREATE POLICY IF NOT EXISTS`**. Drop first:

```sql
DROP POLICY IF EXISTS thing_read ON tabsii.thing;
CREATE POLICY thing_read ON tabsii.thing FOR SELECT USING (...);
```

**Get this right before the file is first applied anywhere.** Once applied, its checksum is recorded and the importer refuses any edit to it — so a non-idempotent file cannot be corrected afterwards, and no later file can rescue it. Only the file's own text decides whether re-running it errors.

`services/api/tests/test_ddl_import_conventions.py` enforces this in CI, checking `CREATE POLICY`, `CREATE TABLE`, `CREATE INDEX` and `ADD COLUMN` across every vendored import. It has nothing to check until you vendor a chain, so it is inert in a fresh repo.

#### Exempting what you can't fix: `.ddl-guard.json`

Two situations legitimately need an exemption. Both are declared in an optional `db/imports/<name>/.ddl-guard.json`, which lives beside your SQL in user-owned space and so survives `biffo core upgrade`:

```json
{
  "first_guarded_module": "015",
  "grandfathered_bare_policies": {
    "029_marketplace_brand_profiles.sql": ["bmp_create", "bmp_read"]
  }
}
```

- **`first_guarded_module`** — if you vendored a chain from a pre-existing schema, its early files are typically one-shot `CREATE TABLE`s that were never meant to re-run. Set this to the first file you actually want held to the convention; anything sorting before it is skipped.
- **`grandfathered_bare_policies`** — for a file that is already applied somewhere and so can no longer be corrected. Policy names are pinned individually, so a *new* bare policy in that same file still fails, and an entry that stops matching is reported as stale.

Both keys are optional; with no file at all, everything is checked and nothing is exempt. Malformed JSON and unknown keys are hard errors rather than being ignored — an exemption you believe is in force but silently isn't would be worse than no guard.

## Guarding a seed to one environment

DDL imports apply to **every** environment you `biffo data apply` them to — there is no separate "dev-only" apply. If a file is demo or fixture data that must never reach staging or prod, guard it in the SQL itself, using the `biffo.environment` GUC `_run_ddl_import` publishes on the connection before any file runs (tabsii-platform#830, [ADR-0005 section 7](../ADR/0005-ddl-import-module.md#7-per-environment-gating-via-a-biffoenvironment-guc)):

```sql
DO $$
BEGIN
  IF current_setting('biffo.environment', true) = 'dev' THEN
    INSERT INTO tabsii.users (...) VALUES (...);
  END IF;
END $$;
```

`current_setting('biffo.environment', true)` reads `NULL` in any deployment that never sets `BIFFO_ENVIRONMENT` — which fails **safe**: `NULL = 'dev'` is never true, so the seed applies nowhere rather than everywhere. This is opt-in and retroactive-proof: nothing about it requires touching an already-applied file (which the checksum lock refuses anyway) — it only affects new files that choose to check it.

There is nothing to set on your end beyond writing the `IF` guard; `BIFFO_ENVIRONMENT` is already set by Terraform for every environment `biffo data apply` can target.

## `biffo data list`

Shows what's been imported into the **local checkout** — it does not check any deployed environment:

```bash
biffo data list
```

```
  tabsii       13 file(s)
  crm-schema    4 file(s)
```

To see what's actually been applied to a given environment's database, run `biffo data apply <name> --env <environment>` again — its "skipped" list is exactly what's already there.

## What kind of SQL can go in these files?

Each file is executed as a whole against the database using Postgres's simple query protocol — the same as running it through `psql -f`. That means:

- Multiple statements per file are fine.
- `SET search_path` (or other session-level state) set by an earlier file carries over to later files in the same `apply` run — the whole batch runs on one connection, in filename order.
- Dollar-quoted function/trigger bodies (`$$ ... $$`) work correctly, including ones containing semicolons.

Each file still runs in its own transaction, so a failure partway through one file rolls back just that file — files already applied earlier in the same run stay applied.
