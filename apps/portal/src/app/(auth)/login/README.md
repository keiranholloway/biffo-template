# Portal branding (`(auth)/login/`)

Issue #1945: this shared, template-owned login page had no branding mechanism
at all — every instance rendered it with Tailwind's own starter-default
gray/blue palette, hardcoded directly into `page.tsx`'s classNames.

## The mechanism

1. **Tokens, not literal colors.** `../../globals.css` defines a small set of
   CSS custom properties (`--primary`, `--surface`, `--on-surface`, …) with
   platform-neutral defaults chosen to match today's look exactly, so an
   instance that sets nothing renders unchanged.
2. **Tailwind consumes the tokens.** `../../../../tailwind.config.ts` maps
   `primary`, `surface`, `on-surface`, etc. to `var(--x)` rather than to a
   literal hex — a `var()` can be overridden per instance at build time, a
   literal baked into a Tailwind build cannot be without forking the config.
3. **`page.tsx` uses the token classes** (`bg-primary`, `text-on-surface`,
   `bg-error-container`, …) across all three states — sign-in, set-new-password,
   forgot-password — instead of `bg-blue-600`/`text-gray-900`/`bg-red-50`.
4. **The actual override point** is `../../layout.tsx`'s
   `NEXT_PUBLIC_PORTAL_PRIMARY_COLOR`, read the same way
   `NEXT_PUBLIC_PORTAL_TITLE` already is (`../../../lib/branding.ts`): a
   build-time env var, forwarded by every "Build portal" step in
   `.github/workflows/deploy-app.yml` from the `PORTAL_PRIMARY_COLOR`
   repository variable. The portal builds with `output: 'export'`, so this is
   baked into the static bundle — an instance sets the repo variable, its next
   deploy build picks it up, with zero divergence from the template. Setting
   it overrides `--primary` via an inline style on `<html>`; `--primary-hover`
   and the rest of the primary-derived tokens follow automatically via
   `color-mix()` in `globals.css`, so one variable is enough for a coherent
   theme rather than needing one override per shade.

## Adding another override

Follow `NEXT_PUBLIC_PORTAL_PRIMARY_COLOR` end to end:

1. Add the token to `globals.css` with a sane default.
2. Read `process.env.NEXT_PUBLIC_<NAME>` in `layout.tsx` (or extend
   `resolvePortalThemeStyle`) and apply it the same way.
3. Forward it from a repository variable in **all three** "Build portal"
   steps in `.github/workflows/deploy-app.yml` (dev, staging, prod).

Step 3 is not optional: `cli/src/lib/portal-build-env.test.ts` fails CI if a
`NEXT_PUBLIC_*` the portal reads is not forwarded (or explicitly allowlisted
with a reason) — `NEXT_PUBLIC_PORTAL_TITLE` shipped without it once (#964) and
silently did nothing for every instance that set the variable, for as long as
the file existed.

## Deliberately not done here

`packages/design-tokens/tokens.css` (`@biffo/design-tokens`) is described in
its own header as "the single definition of the platform's visual language,
for the portal, sibling apps and plugin frontends alike", and is already the
canonical source new sibling/plugin skeletons import. `apps/portal/` is not
wired to it — the tokens above are declared locally in `globals.css` instead.
That is scope, not a judgement that local declaration is the end state: wiring
`apps/portal` to `@biffo/design-tokens` needs a new workspace dependency in
`apps/portal/package.json`, which this fix's read-set did not include. A
follow-up that does that reconciliation should replace this file's `:root`
block with the shared import, the same way
`_skeletons/sibling-template/apps/frontend/src/app/globals.css` already does.
