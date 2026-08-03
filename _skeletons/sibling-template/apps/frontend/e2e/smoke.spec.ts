import { expect, test } from '@playwright/test'
import { BASE_PATH } from './fixtures'
import { signIn } from './session'

/**
 * The one E2E every sibling starts with: **the app boots, and a signed-in
 * session stays signed in.**
 *
 * ## Why this specific assertion
 *
 * It is the regression that actually happened. On 2026-08-03 `tabsii-geo`
 * merged a change moving Cognito pool resolution to runtime (#403), its
 * Playwright harness did not serve `/.well-known/biffo-identity.json`, so
 * `getCurrentSession()` resolved null and the app redirected to the portal.
 * Every spec died on *"Execution context was destroyed, most likely because of
 * a navigation"*. `tabsii-crm` needed the identical fix for the identical
 * reason. The branch stayed red for four hours (#1208).
 *
 * A sibling that renders its own base path while holding a session is a sibling
 * whose build, base path, static export, identity document and auth wiring all
 * agree. Almost every scaffolding mistake breaks one of those, and this catches
 * it in about a second.
 *
 * ## Keep it, then add to it
 *
 * This is a floor, not a suite. Add specs for what your sibling actually does —
 * `tabsii-crm` has brand, FDD and automation flows beside this. But do not
 * delete it: it is the only test that fails loudly when the harness itself
 * stops representing the deployed app, which is the failure mode that costs
 * hours rather than minutes.
 *
 * **Make `E2E (Playwright)` a required status check on `dev`.** `tabsii-geo`
 * had five E2E files and did not require them, so the regression above merged
 * green — coverage that cannot block a merge is documentation.
 */

test('a signed-in session renders the app without redirecting to the portal', async ({ page }) => {
  // Seed the session BEFORE the first navigation. `identity.ts` fetches the
  // identity document and reads localStorage during hydration, so writing the
  // session after `goto` races that and lands on the signed-out path.
  await signIn(page)

  await page.goto(`${BASE_PATH}/`)

  // Still here — not bounced to the portal.
  await expect(page).toHaveURL(new RegExp(`${BASE_PATH}/?$`))

  // And something actually rendered, rather than an empty shell that merely
  // failed to redirect.
  await expect(page.locator('body')).not.toBeEmpty()
})
