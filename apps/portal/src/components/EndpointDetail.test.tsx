import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EndpointDetail } from './EndpointDetail'
import type { EndpointDetail as Detail } from '@/lib/endpoint-api'

function detail(overrides: Partial<Detail> = {}): Detail {
  return {
    method: 'POST',
    path: '/api/v1/public/demo-requests',
    summary: 'Submit demo request',
    description: 'Capture a demo request.',
    parameters: [],
    request_body: {
      content_type: 'application/json',
      fields: [
        {
          name: 'name',
          type: 'string',
          required: true,
          description: null,
          notes: 'max length 200',
        },
        {
          name: 'message',
          type: 'string | null',
          required: false,
          description: 'note',
          notes: null,
        },
      ],
      example: { name: 'string', message: 'string' },
    },
    responses: [
      {
        status_code: '201',
        description: 'Created',
        content_type: 'application/json',
        fields: [{ name: 'id', type: 'string', required: true, description: null, notes: null }],
        example: { id: 'string' },
      },
      {
        status_code: '422',
        description: 'Validation Error',
        content_type: null,
        fields: [],
        example: null,
      },
    ],
    ...overrides,
  }
}

describe('EndpointDetail', () => {
  it('shows loading and error states', () => {
    const { rerender } = render(<EndpointDetail detail={null} loading error={null} />)
    expect(screen.getByLabelText('Loading endpoint details')).toBeInTheDocument()

    rerender(<EndpointDetail detail={null} loading={false} error="boom" />)
    expect(screen.getByText('boom')).toBeInTheDocument()
  })

  it('renders request-body fields and response codes', () => {
    render(<EndpointDetail detail={detail()} loading={false} error={null} />)

    expect(screen.getByText('Capture a demo request.')).toBeInTheDocument()
    // request body fields
    expect(screen.getByText('name')).toBeInTheDocument()
    expect(screen.getByText('string | null')).toBeInTheDocument()
    expect(screen.getByText('max length 200')).toBeInTheDocument()
    // responses, including a bare status with no body
    expect(screen.getByText('201')).toBeInTheDocument()
    expect(screen.getByText('422')).toBeInTheDocument()
    expect(screen.getByText('id')).toBeInTheDocument()
    // an example block is offered
    expect(screen.getAllByText('Example').length).toBeGreaterThanOrEqual(1)
  })

  it('renders parameters when present', () => {
    render(
      <EndpointDetail
        detail={detail({
          request_body: null,
          parameters: [
            { name: 'id', location: 'path', type: 'string', required: true, description: 'row id' },
          ],
        })}
        loading={false}
        error={null}
      />,
    )
    expect(screen.getByText('id (path)')).toBeInTheDocument()
    expect(screen.getByText('row id')).toBeInTheDocument()
  })
})
