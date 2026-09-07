/**
 * Portal branding (issue #389).
 *
 * The portal title was hard-coded to 'Biffo Portal', so branding an instance
 * meant diverging from the template. Instead it reads a build-time env var:
 * `NEXT_PUBLIC_PORTAL_TITLE`. The portal builds with `output: 'export'`, so
 * `NEXT_PUBLIC_*` values are baked into the static bundle at build time — an
 * instance sets the GitHub var and its deploy build picks it up, with zero
 * divergence from the template.
 *
 * The fallback stays exactly 'Biffo Portal', so an un-branded instance (the
 * var unset) is unchanged.
 *
 * The other half of that mechanism is the `Build portal` step in
 * `.github/workflows/deploy-app.yml`, which forwards `vars.PORTAL_TITLE` into
 * this name. It did not, for as long as this file has existed, so setting the
 * repo variable did nothing and every instance saw 'Biffo Portal' regardless
 * (#964) — a var read here but forwarded nowhere is silent by construction.
 * `cli/src/lib/portal-build-env.test.ts` now holds the two halves together;
 * adding another `NEXT_PUBLIC_*` here without forwarding it there fails CI.
 */
export const PORTAL_TITLE = process.env.NEXT_PUBLIC_PORTAL_TITLE || 'Biffo Portal'

/**
 * Instance logo/wordmark override (issue #1965), read the same way
 * `PORTAL_TITLE` is above: a build-time `NEXT_PUBLIC_*` env var, forwarded by
 * every "Build portal" step in `.github/workflows/deploy-app.yml` from the
 * `PORTAL_LOGO_URL` repository variable. The portal builds with
 * `output: 'export'`, so this is baked into the static bundle — an instance
 * sets the repo variable to a URL for its own hosted logo asset (this
 * mechanism carries no image, only the pointer to one) and its next deploy
 * build picks it up, with zero divergence from the template.
 *
 * Unset (`''`/`undefined`) is the normal case and renders no `<img>` at all —
 * `(auth)/layout.tsx` checks this before rendering anything, so an
 * un-branded instance (this repo's own `biffo-platform` included) keeps
 * today's text-only login header unchanged, never a broken image.
 */
export const PORTAL_LOGO_URL = process.env.NEXT_PUBLIC_PORTAL_LOGO_URL || undefined
