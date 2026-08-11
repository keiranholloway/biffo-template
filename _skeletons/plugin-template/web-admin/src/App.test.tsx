import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { __resetCoreIdentityForTests } from './lib/identity'
import { __resetUserPoolForTests } from './lib/auth'

afterEach(() => {
  vi.restoreAllMocks()
  __resetCoreIdentityForTests()
  __resetUserPoolForTests()
})

describe('App', () => {
  it('shows the signed-out message when the identity document is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'))

    render(<App />)

    expect(await screen.findByText(/not signed in/i)).toBeInTheDocument()
  })
})
