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
