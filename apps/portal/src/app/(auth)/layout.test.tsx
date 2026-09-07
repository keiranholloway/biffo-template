import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AuthLayout from './layout'

/**
 * `AuthLayout` reads `PORTAL_LOGO_URL`/`PORTAL_TITLE` from `@/lib/branding`
 * (issue #1965, mirroring the `PORTAL_PRIMARY_COLOR` override tested in
 * `../layout.test.tsx`). Those are `const`s resolved once from
 * `process.env.NEXT_PUBLIC_*` at module load, so — unlike
 * `resolvePortalThemeStyle`, which is a plain exported function taking the
 * value as a parameter — exercising both the set and unset states here means
 * mocking the module rather than calling a pure function directly. The mock
 * is mutable per test via `vi.hoisted` so both states can be asserted in one
 * file without a full module re-import between them.
 */
const { brandingMock } = vi.hoisted(() => ({
  brandingMock: { PORTAL_LOGO_URL: undefined as string | undefined, PORTAL_TITLE: 'Biffo Portal' },
}))

vi.mock('@/lib/branding', () => ({
  get PORTAL_LOGO_URL() {
    return brandingMock.PORTAL_LOGO_URL
  },
  get PORTAL_TITLE() {
    return brandingMock.PORTAL_TITLE
  },
}))

describe('AuthLayout — logo override (issue #1965)', () => {
  afterEach(() => {
    brandingMock.PORTAL_LOGO_URL = undefined
    brandingMock.PORTAL_TITLE = 'Biffo Portal'
  })

  it('renders no image when no instance logo is set (un-branded default)', () => {
    render(
      <AuthLayout>
        <p>form</p>
      </AuthLayout>,
    )
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    // The text-only header stays exactly as it was before this mechanism
    // existed — no broken image, no layout shift.
    expect(screen.getByText('form')).toBeInTheDocument()
  })

  it('renders the instance logo when PORTAL_LOGO_URL is set', () => {
    brandingMock.PORTAL_LOGO_URL = 'https://cdn.example-instance.com/brand/logo.svg'
    brandingMock.PORTAL_TITLE = 'Acme Portal'
    render(
      <AuthLayout>
        <p>form</p>
      </AuthLayout>,
    )
    const img = screen.getByRole('img', { name: 'Acme Portal' })
    expect(img).toHaveAttribute('src', 'https://cdn.example-instance.com/brand/logo.svg')
  })

  it('still renders children alongside a set logo', () => {
    brandingMock.PORTAL_LOGO_URL = 'https://cdn.example-instance.com/brand/logo.svg'
    render(
      <AuthLayout>
        <p>form</p>
      </AuthLayout>,
    )
    expect(screen.getByRole('img')).toBeInTheDocument()
    expect(screen.getByText('form')).toBeInTheDocument()
  })
})
