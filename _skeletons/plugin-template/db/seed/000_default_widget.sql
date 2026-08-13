-- example-plugin's baseline-row seed (biffo-template#1554).
--
-- Declared by biffo.plugin.json's `seed` block (`dir: "db/seed"`,
-- `baseline_tables: ["example_widgets"]`). `biffo plugin install`/`upgrade`
-- vendor every *.sql file in this directory into the installing instance's
-- `db/imports/_plugin-example-plugin/`, where that instance's existing
-- "Apply DDL imports" deploy step (ADR-0005) applies it on every deploy —
-- no token, no per-tenant API call, no new deploy machinery. See
-- README.md's "Seeding" section and `plugin.py`'s `seed_default_widget()`
-- docstring for the two-mechanism picture this is one half of.
--
-- IDEMPOTENCY CONTRACT (read before copying this into your own plugin):
-- once applied, this file is checksum-tracked in ddl_import_history — an
-- edit to it after that point makes the next deploy fail loudly rather than
-- silently re-applying or silently skipping (ADR-0005 section 4). A later
-- change to this plugin's baseline data must ship as a NEW, additively
-- numbered file (001_..., 002_...), never as an edit to this one.
--
-- INSERT ... SELECT ... WHERE NOT EXISTS is the shape every seed file here
-- must follow: it reads the known tenants from `users` (Core's own
-- Alembic-managed table — see plugin_baseline_check.py's module docstring
-- for why that, not a generic `tenants` table, is what "known tenant" means
-- in this template) and inserts exactly one starter widget per tenant that
-- doesn't already have one, so re-running this file on every deploy is
-- always a no-op once each tenant has its row. Mirrors the shape (same
-- name, same description, same idempotent "insert if missing by name" logic)
-- of `seed_default_widget()` in `plugin.py` — that one seeds lazily, over
-- the API, from one plugin process's own ASGI lifespan; this one seeds every
-- known tenant in a single statement, from the instance's own deploy step.
-- Both are legitimate; which one to use for YOUR plugin is exactly the
-- question BiffoPluginBase's class docstring answers.
INSERT INTO example_widgets (id, tenant_id, name, description, is_active, created_at, updated_at)
SELECT
  gen_random_uuid()::text,
  known_tenant.tenant_id,
  'starter-widget',
  'Created by this plugin''s baseline seed. Safe to delete.',
  true,
  now(),
  now()
FROM (SELECT DISTINCT tenant_id FROM users) AS known_tenant
WHERE NOT EXISTS (
  SELECT 1
  FROM example_widgets existing
  WHERE existing.tenant_id = known_tenant.tenant_id
    AND existing.name = 'starter-widget'
);
