import type { EndpointDetail as Detail, ResponseSpec, SchemaField } from '@/lib/endpoint-api'

// The swagger-ish "specifics" panel for one endpoint: parameters, request body,
// and responses, each as a field table with a synthesized example. Purely
// presentational — the page fetches the detail and owns loading/error — so it's
// easy to extend (a copy-as-curl button, a "try it" console, etc. slot in here).

function statusColor(code: string): string {
  if (code.startsWith('2')) return 'bg-emerald-100 text-emerald-700'
  if (code.startsWith('4')) return 'bg-amber-100 text-amber-700'
  if (code.startsWith('5')) return 'bg-rose-100 text-rose-700'
  return 'bg-gray-100 text-gray-700'
}

function FieldTable({ fields }: { fields: SchemaField[] }) {
  if (fields.length === 0) {
    return <p className="text-xs text-gray-400">No fields.</p>
  }
  return (
    <table className="min-w-full text-xs">
      <thead className="text-left text-gray-500">
        <tr>
          <th className="py-1 pr-4 font-medium">Field</th>
          <th className="py-1 pr-4 font-medium">Type</th>
          <th className="py-1 pr-4 font-medium">Required</th>
          <th className="py-1 font-medium">Notes</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {fields.map((f) => (
          <tr key={f.name} className="align-top">
            <td className="py-1 pr-4 font-mono text-gray-800">{f.name}</td>
            <td className="py-1 pr-4 font-mono text-gray-600">{f.type}</td>
            <td className="py-1 pr-4">
              {f.required ? (
                <span className="text-gray-700">yes</span>
              ) : (
                <span className="text-gray-400">no</span>
              )}
            </td>
            <td className="py-1 text-gray-500">
              {f.description}
              {f.description != null && f.notes != null ? ' · ' : ''}
              {f.notes}
              {f.description == null && f.notes == null ? (
                <span className="text-gray-300">—</span>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ExampleBlock({ example }: { example: unknown }) {
  if (example == null) return null
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-medium text-gray-500">Example</summary>
      <pre className="mt-1 overflow-x-auto rounded bg-gray-900 p-3 text-xs leading-relaxed text-gray-100">
        {JSON.stringify(example, null, 2)}
      </pre>
    </details>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h4>
      <div className="mt-1.5">{children}</div>
    </div>
  )
}

function ResponseBlock({ response }: { response: ResponseSpec }) {
  return (
    <div className="rounded border border-gray-200 bg-white p-3">
      <div className="flex items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-xs font-semibold ${statusColor(
            response.status_code,
          )}`}
        >
          {response.status_code}
        </span>
        {response.description != null && (
          <span className="text-xs text-gray-600">{response.description}</span>
        )}
      </div>
      {response.fields.length > 0 && (
        <div className="mt-2">
          <FieldTable fields={response.fields} />
        </div>
      )}
      <ExampleBlock example={response.example} />
    </div>
  )
}

export function EndpointDetail({
  detail,
  loading,
  error,
}: {
  detail: Detail | null
  loading: boolean
  error: string | null
}) {
  if (loading) {
    return (
      <div className="space-y-2" aria-label="Loading endpoint details">
        {[0, 1].map((i) => (
          <div key={i} className="h-6 animate-pulse rounded bg-gray-100" />
        ))}
      </div>
    )
  }
  if (error != null) {
    return <p className="text-sm text-red-700">{error}</p>
  }
  if (detail == null) return null

  return (
    <div className="flex flex-col gap-4">
      {detail.description != null && detail.description !== '' && (
        <p className="whitespace-pre-line text-sm text-gray-600">{detail.description}</p>
      )}

      {detail.parameters.length > 0 && (
        <Section title="Parameters">
          <FieldTable
            fields={detail.parameters.map((p) => ({
              name: `${p.name} (${p.location})`,
              type: p.type,
              required: p.required,
              description: p.description,
              notes: null,
            }))}
          />
        </Section>
      )}

      {detail.request_body != null && (
        <Section title={`Request body · ${detail.request_body.content_type}`}>
          <FieldTable fields={detail.request_body.fields} />
          <ExampleBlock example={detail.request_body.example} />
        </Section>
      )}

      <Section title="Responses">
        <div className="flex flex-col gap-2">
          {detail.responses.length === 0 ? (
            <p className="text-xs text-gray-400">No documented responses.</p>
          ) : (
            detail.responses.map((r) => <ResponseBlock key={r.status_code} response={r} />)
          )}
        </div>
      </Section>
    </div>
  )
}
