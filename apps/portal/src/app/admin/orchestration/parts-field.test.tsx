import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { PartsField } from './parts-field'
import type { PromptComponent } from '@/lib/prompt-components-api'
import type { PromptPart } from '@/lib/prompt-parts'

const houseStyle: PromptComponent = {
  id: 'pc-1',
  tenant_id: 'default',
  created_at: '2026-07-20T09:30:00Z',
  updated_at: '2026-07-20T09:30:00Z',
  name: 'house-style',
  description: 'Shared tone',
  body: 'State confidence per claim.',
  variables: [],
}

const leadScorer: PromptComponent = {
  id: 'pc-2',
  tenant_id: 'default',
  created_at: '2026-07-20T09:30:00Z',
  updated_at: '2026-07-20T09:30:00Z',
  name: 'lead-scorer',
  description: 'Score leads for a region',
  body: 'Score leads for {{region}}.',
  variables: [
    { name: 'region', description: 'Target region', required: true },
    { name: 'tone', required: false, default: 'formal' },
  ],
}

const COMPONENTS = [houseStyle, leadScorer]

/** A stateful harness so the controlled PartsField round-trips, and `latest`
 *  exposes the most recent value for assertions. */
function Harness({
  initial = [],
  components = COMPONENTS,
  onValue,
}: {
  initial?: PromptPart[]
  components?: PromptComponent[]
  onValue?: (parts: PromptPart[]) => void
}) {
  const [value, setValue] = useState<PromptPart[]>(initial)
  return (
    <PartsField
      label="Instructions"
      value={value}
      components={components}
      onChange={(parts) => {
        setValue(parts)
        onValue?.(parts)
      }}
    />
  )
}

describe('PartsField', () => {
  it('adds an inline part and round-trips its text as JSON', () => {
    const onValue = vi.fn()
    render(<Harness onValue={onValue} />)

    // Empty state before any part is added.
    expect(screen.getByText(/No parts yet/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add text' }))
    fireEvent.change(screen.getByLabelText('Instructions part 1 text'), {
      target: { value: 'Assess this demo request.' },
    })

    expect(onValue).toHaveBeenLastCalledWith([{ inline: 'Assess this demo request.' }])
  })

  it('adds a component part, shows its variables, and writes component+values JSON', () => {
    const onValue = vi.fn()
    render(<Harness onValue={onValue} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add component' }))
    // Seeds with the first available component.
    expect(onValue).toHaveBeenLastCalledWith([{ component: 'house-style', values: {} }])

    // Switch to the parameterised component; its declared variables appear.
    fireEvent.change(screen.getByLabelText('Instructions part 1 component'), {
      target: { value: 'lead-scorer' },
    })
    const regionInput = screen.getByLabelText('Instructions part 1 value for region')
    const toneInput = screen.getByLabelText('Instructions part 1 value for tone')
    expect(regionInput).toBeInTheDocument()
    expect(toneInput).toBeInTheDocument()

    fireEvent.change(regionInput, { target: { value: 'Midlands' } })
    expect(onValue).toHaveBeenLastCalledWith([
      { component: 'lead-scorer', values: { region: 'Midlands' } },
    ])
  })

  it('loads existing inline + component-with-values parts and preserves order', () => {
    render(
      <Harness
        initial={[
          { component: 'lead-scorer', values: { region: 'London' } },
          { inline: 'Then summarise.' },
        ]}
      />,
    )
    // Component part renders its stored value; inline part renders its text.
    expect(screen.getByLabelText('Instructions part 1 value for region')).toHaveValue('London')
    expect(screen.getByLabelText('Instructions part 2 text')).toHaveValue('Then summarise.')
  })

  it('reorders parts', () => {
    const onValue = vi.fn()
    render(<Harness initial={[{ inline: 'first' }, { inline: 'second' }]} onValue={onValue} />)
    fireEvent.click(screen.getByRole('button', { name: 'Move Instructions part 2 up' }))
    expect(onValue).toHaveBeenLastCalledWith([{ inline: 'second' }, { inline: 'first' }])
  })

  it('removes a part', () => {
    const onValue = vi.fn()
    render(<Harness initial={[{ inline: 'keep' }, { inline: 'drop' }]} onValue={onValue} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Instructions part 2' }))
    expect(onValue).toHaveBeenLastCalledWith([{ inline: 'keep' }])
  })

  it('pre-warns on an unset required variable (UX only)', () => {
    render(<Harness initial={[{ component: 'lead-scorer', values: {} }]} />)
    // `region` is required with no value and no default -> warning.
    expect(screen.getByText(/Required — set a value/)).toBeInTheDocument()
  })

  it('pre-warns on an unknown component reference', () => {
    render(<Harness initial={[{ component: 'ghost', values: {} }]} />)
    expect(screen.getByText(/not in the library/)).toBeInTheDocument()
    // The unknown name stays selected rather than silently reassigning.
    expect(screen.getByLabelText('Instructions part 1 component')).toHaveValue('ghost')
  })

  it('renders cleanly with an empty components list', () => {
    render(<Harness components={[]} />)
    expect(screen.getByText(/No components in the library yet/)).toBeInTheDocument()
    // Adding a component part with none available seeds an empty selection.
    fireEvent.click(screen.getByRole('button', { name: 'Add component' }))
    expect(screen.getByLabelText('Instructions part 1 component')).toHaveValue('')
  })
})
