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
 */
export const PORTAL_TITLE = process.env.NEXT_PUBLIC_PORTAL_TITLE || 'Biffo Portal'
