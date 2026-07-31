/**
 * Your instance's own admin nav entries — **user-owned** (ADR-0028).
 *
 * This file is yours. `core-manifest.json` lists it under `userOwned`, so the
 * core-ownership guard will not block your edits and `biffo core upgrade` will
 * never carry it, even though everything else under `apps/portal/` is
 * template-owned.
 *
 * It exists so that adding an admin surface never requires patching the
 * template-owned `src/components/nav.tsx`. Put the route itself under the
 * user-owned route group `src/app/admin/(instance)/` (see its README) and
 * declare its nav entry here:
 *
 * ```ts
 * export const INSTANCE_NAV_LINKS: InstanceNavLink[] = [
 *   { href: '/admin/demo-requests/', label: 'Demo requests' },
 * ]
 * ```
 *
 * Entries render after the core links, in declaration order. Hrefs are
 * canonicalised to the trailing-slash form this app's static export requires
 * (#275), and a malformed entry is dropped rather than breaking the nav — see
 * `@/lib/instance-nav-contract`, which is template-owned and defines the shape.
 *
 * The base template ships **no** entries.
 */
import type { InstanceNavLink } from '@/lib/instance-nav-contract'

export const INSTANCE_NAV_LINKS: InstanceNavLink[] = []
