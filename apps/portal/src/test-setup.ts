import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/react'

// Default is 1000ms. The login page's already-signed-in forward now runs a
// deliberate delay before redirecting (FORWARD_DELAY_MS, #1942) so "Not you?
// Sign out" has a real window to be clicked — `waitFor` assertions against the
// eventual redirect need enough headroom to clear that delay, not just the
// mocked async work that used to be the only wait.
configure({ asyncUtilTimeout: 3000 })
