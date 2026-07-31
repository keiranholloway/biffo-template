/**
 * The fallback `@/instance-nav` resolves to when an instance has not declared
 * one — **template-owned**, and the reason `src/instance-nav.ts` is optional.
 *
 * ADR-0028 gave instances a user-owned place to declare admin nav entries, and
 * template-owned `nav.tsx` imports it *statically*. A bundler resolves static
 * imports at build time and cannot degrade, so every instance had to carry a
 * file whose entire content was an empty array — and any instance created
 * before ADR-0028 would fail `module not found` on its next `core upgrade`,
 * because `core upgrade` deliberately never carries user-owned paths.
 *
 * That is the asymmetry ADR-0022 does not have: Python domain discovery globs
 * at *runtime* and simply finds nothing. A bundler resolves earlier and harder.
 *
 * The fix is a fallback rather than a mandatory file. `apps/portal/tsconfig.json`
 * maps `@/instance-nav` to an ordered list — the instance's own file first, this
 * second — so both TypeScript and Next's webpack resolver use whichever exists.
 * An instance that wants nav entries creates the file; one that does not never
 * learns this seam exists.
 *
 * Do not add entries here. This is the empty case by definition; an instance's
 * entries belong in its own user-owned `src/instance-nav.ts`.
 */
import type { InstanceNavLink } from '@/lib/instance-nav-contract'

export const INSTANCE_NAV_LINKS: InstanceNavLink[] = []
