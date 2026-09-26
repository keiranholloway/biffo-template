import { afterEach, describe, expect, it } from 'vitest'
import { startLocalAwsSink, type LocalAwsSink } from './local-aws-sink.js'

let sink: LocalAwsSink | undefined
afterEach(async () => {
  await sink?.close()
  sink = undefined
})

const call = (url: string, target: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'x-amz-target': target, 'content-type': 'application/x-amz-json-1.1' },
    body: JSON.stringify(body),
  })

describe('local AWS sink', () => {
  it('records EventBridge PutEvents so a run can assert on it', async () => {
    sink = await startLocalAwsSink()
    const res = await call(sink.url, 'AWSEvents.PutEvents', { Entries: [{ DetailType: 'x' }] })
    expect(res.status).toBe(200)
    expect(sink.events).toHaveLength(1)
  })

  it('serves an SSM parameter, and reports a missing one as ParameterNotFound (not empty)', async () => {
    sink = await startLocalAwsSink(new Map([['/biffo-dev/p/k', 'v']]))
    const hit = await call(sink.url, 'AmazonSSM.GetParameter', { Name: '/biffo-dev/p/k' })
    expect(((await hit.json()) as { Parameter: { Value: string } }).Parameter.Value).toBe('v')
    const miss = await call(sink.url, 'AmazonSSM.GetParameter', { Name: '/nope' })
    expect(miss.status).toBe(400)
    expect(((await miss.json()) as { __type: string }).__type).toBe('ParameterNotFound')
  })

  it('answers an unimplemented service 501 and RECORDS it — never a silent success', async () => {
    sink = await startLocalAwsSink()
    const res = await call(sink.url, 'AWSLambda.Invoke', {})
    expect(res.status).toBe(501)
    expect(sink.unexpected).toEqual(['AWSLambda.Invoke'])
  })

  it('tolerates a non-JSON body', async () => {
    sink = await startLocalAwsSink()
    const res = await fetch(sink.url, {
      method: 'POST',
      headers: { 'x-amz-target': 'AWSEvents.PutEvents' },
      body: 'not json',
    })
    expect(res.status).toBe(200)
  })
})
