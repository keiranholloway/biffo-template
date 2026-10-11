import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginPanelClient } from './plugin-panel-client'

const params = vi.hoisted(() => ({ value: new URLSearchParams() }))
vi.mock('next/navigation', () => ({ useSearchParams: () => params.value }))

afterEach(cleanup)

describe('PluginPanelClient', () => {
  it('frames the plugin admin surface named in the query string', () => {
    params.value = new URLSearchParams('name=idea-scout')
    render(<PluginPanelClient />)
    const frame = screen.getByTitle('Idea Scout admin')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame).toHaveAttribute('src', '/api/v1/plugins/idea-scout/admin')
  })

  it('refuses a missing or malformed name and offers a way back', () => {
    params.value = new URLSearchParams('name=../evil')
    render(<PluginPanelClient />)
    expect(document.querySelector('iframe')).toBeNull()
    expect(screen.getByRole('link', { name: 'Back to the portal' })).toBeInTheDocument()
  })
})
