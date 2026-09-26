import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A local stand-in for the two AWS services the composition's processes call
 * (biffo-template#1522 Q3): EventBridge `PutEvents` (Core's fail-soft publish —
 * recorded, so a run can ASSERT on it instead of trusting a 201) and SSM
 * `GetParameter` (plugin secret resolution, #1517's `resolve_secret`, served from
 * the local dev config file). Any other AWS call is answered 501 and RECORDED in
 * `unexpected` — a service nobody wired is a loud finding, never a silent pass.
 */
export interface LocalAwsSink {
  url: string
  events: unknown[]
  /** `X-Amz-Target` (or "unknown") of every call the sink did not implement. */
  unexpected: string[]
  parameters: Map<string, string>
  close(): Promise<void>
}

export async function startLocalAwsSink(
  parameters: Map<string, string> = new Map(),
): Promise<LocalAwsSink> {
  const events: unknown[] = []
  const unexpected: string[] = []
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    const out = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/x-amz-json-1.1',
      'content-length': Buffer.byteLength(out),
    })
    res.end(out)
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const target = String(req.headers['x-amz-target'] ?? 'unknown')
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
      } catch {
        body = {}
      }
      if (target.endsWith('.PutEvents')) {
        events.push(body)
        json(res, 200, { FailedEntryCount: 0, Entries: [{ EventId: `dev-${events.length}` }] })
      } else if (target === 'AmazonSSM.GetParameter') {
        const name = String(body.Name ?? '')
        const value = parameters.get(name)
        if (value === undefined) {
          json(res, 400, { __type: 'ParameterNotFound', message: `Parameter ${name} not found.` })
        } else {
          json(res, 200, { Parameter: { Name: name, Type: 'SecureString', Value: value } })
        }
      } else {
        unexpected.push(target)
        json(res, 501, { __type: 'NotImplemented', message: `local AWS sink: ${target}` })
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    events,
    unexpected,
    parameters,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
