import { describe, expect, it } from 'vitest'
import { ROOT_SIBLING_NAME, siblingHref, siblingRouteHref } from './siblings-api'

describe('siblingHref', () => {
  it('links an ordinary sibling to /<name>, no trailing slash', () => {
    expect(siblingHref('crm')).toBe('/crm')
  })

  it('links the root sibling to / instead of /app', () => {
    expect(siblingHref(ROOT_SIBLING_NAME)).toBe('/')
  })
})

describe('siblingRouteHref', () => {
  it('links an ordinary sibling route to /<name>/<path>', () => {
    expect(siblingRouteHref('intake', 'demo')).toBe('/intake/demo')
  })

  it('links a root sibling route to /<path>, omitting the reserved name', () => {
    expect(siblingRouteHref(ROOT_SIBLING_NAME, 'dashboard')).toBe('/dashboard')
  })
})
