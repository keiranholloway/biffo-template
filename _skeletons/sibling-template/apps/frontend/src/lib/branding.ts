/**
 * Sibling branding (issue #963).
 *
 * The skeleton's root layout used to hard-code `metadata.title = 'Sibling App'`,
 * and nothing at `biffo sibling create` time ever touched it — so every sibling
 * ever scaffolded was born mislabeled in every browser tab, visibly in the
 * deployed `out/index.html`, until a human noticed and fixed it by hand.
 *
 * Instead, derive it from the sibling's own name the same way `page.tsx`
 * already does: the build-time `NEXT_PUBLIC_SIBLING_NAME`. That variable is
 * already wired end to end — `biffo sibling create` writes the repo variable
 * `PROJECT_NAME`, `.github/workflows/deploy.yml` passes it to the frontend
 * build as `NEXT_PUBLIC_SIBLING_NAME`, and `apps/frontend/.env.example` is
 * templated with the sibling's name at create time for local runs. The
 * frontend builds with `output: 'export'`, so the value is baked into the
 * static bundle; there is nothing to read at runtime.
 *
 * This mirrors `apps/portal/src/lib/branding.ts` upstream (issue #389), which
 * solved the identical problem for the portal with a build-time env var rather
 * than a scaffold-time source patch. Reading an env var beats regex-patching a
 * `.tsx` file at create time: one mechanism, no fragile source rewrite, and it
 * keeps working when the sibling is later renamed.
 *
 * The title is the sibling's OWN name only, never `<core project> - <sibling>`.
 * The template is deliberately brand-agnostic and has no reliable way to know
 * an instance's brand (as opposed to its `project.name`) at sibling-create
 * time. A sibling that wants a brand prefix owns its own `layout.tsx` and can
 * add one.
 */

/**
 * Turn a project slug into something presentable in a browser tab:
 * `reports` → `Reports`, `field-ops` → `Field Ops`, `tabsii_crm` → `Tabsii Crm`.
 *
 * Deliberately dumb and deterministic — it does not try to guess acronyms
 * (`crm` → `CRM`), because guessing wrong is worse than being plain and a
 * sibling that cares can override the title outright.
 */
export function formatSiblingTitle(rawName: string | undefined): string {
  const words = (rawName ?? '')
    .split(/[-_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))

  // Fallback for a frontend run with no env at all (a bare `pnpm dev` before
  // `.env.example` is copied). Matches page.tsx's own fallback for the same
  // variable, and is deliberately NOT the old 'Sibling App' literal.
  return words.length > 0 ? words.join(' ') : 'Sibling'
}

export const SIBLING_TITLE = formatSiblingTitle(process.env['NEXT_PUBLIC_SIBLING_NAME'])
