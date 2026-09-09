import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import App from './App'

describe('App', () => {
  it('renders text naming the plugin', () => {
    render(<App />)

    // A blank shell that merely mounts proves nothing — this asserts the
    // actual plugin name is on the page. `biffo plugin create` rewrites
    // `example-plugin` to the real slug everywhere (see
    // ../.scaffold-tokens.json two directories up), including this literal,
    // so the assertion stays true for whatever plugin gets scaffolded.
    expect(screen.getByRole('heading', { name: 'example-plugin' })).toBeInTheDocument()
  })
})
