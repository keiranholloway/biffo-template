import { defineConfig, devices } from '@playwright/test'
import {
  BASE_PATH,
  BUILD_ENV,
  COGNITO_CLIENT_ID,
  COGNITO_USER_POOL_ID,
  E2E_PORT,
} from './e2e/fixtures'

// Browser E2E harness for this sibling's static-export frontend.
//
// The webServer builds the export and serves it base-path aware on a local
// port, including `/.well-known/biffo-identity.json` — the document the app
// resolves its Cognito pool from at runtime (#403). Serving it is not optional:
// without it `getCurrentSession()` resolves null, the app redirects to the
// portal, and every spec dies on a navigation. That is precisely how
// tabsii-geo's CI broke for four hours (#1208).
const baseURL = `http://127.0.0.1:${E2E_PORT}`
const isCI = !!process.env['CI']

export default defineConfig({
  testDir: './e2e',
  // Only *.spec.ts are tests; fixtures.ts / session.ts / static-server.mjs are helpers.
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  ...(isCI ? { workers: 1 } : {}),
  reporter: isCI ? [['github'], ['list']] : 'list',
  use: { baseURL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm run build && node e2e/static-server.mjs',
    url: `${baseURL}${BASE_PATH}/`,
    reuseExistingServer: !isCI,
    timeout: 180_000,
    env: {
      ...BUILD_ENV,
      E2E_PORT: String(E2E_PORT),
      E2E_BASE_PATH: BASE_PATH,
      E2E_COGNITO_USER_POOL_ID: COGNITO_USER_POOL_ID,
      E2E_COGNITO_CLIENT_ID: COGNITO_CLIENT_ID,
    },
  },
})
