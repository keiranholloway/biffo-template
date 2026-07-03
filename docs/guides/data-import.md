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
