import { describe, expect, it } from 'vitest'
import { resolvePortalThemeStyle } from './layout'

/**
 * `resolvePortalThemeStyle` is exported as a plain function (issue #1945)
 * specifically so this can assert the override logic without rendering a
 * full `<html>`/`<body>` document through testing-library, which does not
 * support replacing jsdom's own document root.
 */
describe('resolvePortalThemeStyle', () => {
  it('produces no inline style when no instance override is set', () => {
    expect(resolvePortalThemeStyle(undefined)).toBeUndefined()
  })

  it('produces no inline style for an empty string', () => {
    // `process.env.NEXT_PUBLIC_PORTAL_PRIMARY_COLOR || undefined` already
    // normalises '' to undefined before this function ever sees it, but this
    // function is exported and could be called directly -- an empty override
    // must still be a no-op rather than emitting `style="--primary: "`.
    expect(resolvePortalThemeStyle('')).toBeUndefined()
  })

  it('overrides --primary when an instance sets a brand color', () => {
    expect(resolvePortalThemeStyle('#006c49')).toEqual({ '--primary': '#006c49' })
  })
})
