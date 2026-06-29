/**
 * HTTP-level integration tests for GitHubAdapter.
 *
 * Unlike github.test.ts (which mocks the Octokit module), these tests use a
 * real Octokit instance and intercept outbound HTTP requests via MSW. This
 * catches mistakes the module-level mock can't: wrong endpoint URLs, malformed
 * request bodies, and incorrect handling of real HTTP error responses.
 */
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BiffoConfigSchema } from '../../../config/schema.js'
import { GitHubAdapter } from './index.js'

vi.mock('node:child_process', () => ({ execSync: vi.fn() }))

const GH = 'https://api.github.com'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const CONFIG = BiffoConfigSchema.parse({
  project: { name: 'my-app', description: 'Test', domain: 'example.com' },
  source_control: { provider: 'github', config: { org: 'acme', repo: 'my-app' } },
  cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
  environments: ['dev'],
  admin: { email: 'a@b.com', username: 'a' },
})

function makeAdapter() {
  return new GitHubAdapter('test-token', { templateOwner: 'tmpl-owner', templateRepo: 'tmpl-repo' })
}

// ─── waitForBranch ────────────────────────────────────────────────────────────

describe('waitForBranch (HTTP level)', () => {
  it('polls on HTTP 404 and resolves when the branch returns 200', async () => {
    let callCount = 0
    server.use(
      http.get(`${GH}/repos/acme/my-app/branches/main`, () => {
        callCount++
        if (callCount < 3)
          return HttpResponse.json({ message: 'Branch not found' }, { status: 404 })
        return HttpResponse.json({ name: 'main', commit: { sha: 'abc' } })
      }),
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (makeAdapter() as any).waitForBranch('acme', 'my-app', 'main', 10_000, 10)
    expect(callCount).toBe(3)
  })

  it('throws a descriptive error when the branch never appears within the timeout', async () => {
    server.use(
      http.get(`${GH}/repos/acme/my-app/branches/main`, () =>
        HttpResponse.json({ message: 'Branch not found' }, { status: 404 }),
      ),
    )

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (makeAdapter() as any).waitForBranch('acme', 'my-app', 'main', 50, 10),
    ).rejects.toThrow('Branch "main" not found in acme/my-app')
  })

  it('re-throws non-404 HTTP errors immediately without retrying', async () => {
    let callCount = 0
    server.use(
      http.get(`${GH}/repos/acme/my-app/branches/main`, () => {
        callCount++
        return HttpResponse.json({ message: 'Forbidden' }, { status: 403 })
      }),
    )

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (makeAdapter() as any).waitForBranch('acme', 'my-app', 'main', 10_000, 10),
    ).rejects.toThrow()
    expect(callCount).toBe(1)
  })
})

// ─── configureBranchProtection ────────────────────────────────────────────────

describe('configureBranchProtection (HTTP level)', () => {
  it('sends the correct branch protection payload to the GitHub API', async () => {
    let capturedBody: unknown
    server.use(
      http.get(`${GH}/repos/acme/my-app/branches/main`, () =>
        HttpResponse.json({ name: 'main', commit: { sha: 'abc' } }),
      ),
      http.put(`${GH}/repos/acme/my-app/branches/main/protection`, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json({})
      }),
    )

    await makeAdapter().configureBranchProtection(CONFIG)
    expect(capturedBody).toMatchSnapshot()
  })
})

// ─── createRepoFromTemplate ───────────────────────────────────────────────────

describe('createRepoFromTemplate (HTTP level)', () => {
  it('sends correct request to POST /generate and returns clone_url', async () => {
    let capturedBody: unknown
    server.use(
      http.get(`${GH}/repos/tmpl-owner/tmpl-repo`, () => HttpResponse.json({ is_template: true })),
      http.get(`${GH}/repos/acme/my-app`, () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
      http.post(`${GH}/repos/tmpl-owner/tmpl-repo/generate`, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json({
          clone_url: 'https://github.com/acme/my-app.git',
          html_url: 'https://github.com/acme/my-app',
        })
      }),
    )

    const url = await makeAdapter().createRepoFromTemplate(CONFIG)
    expect(url).toBe('https://github.com/acme/my-app.git')
    expect(capturedBody).toMatchSnapshot()
  })

  it('skips POST /generate when the destination repo already exists', async () => {
    let generateCalled = false
    server.use(
      http.get(`${GH}/repos/tmpl-owner/tmpl-repo`, () => HttpResponse.json({ is_template: true })),
      http.get(`${GH}/repos/acme/my-app`, () =>
        HttpResponse.json({ clone_url: 'https://github.com/acme/my-app.git' }),
      ),
      http.post(`${GH}/repos/tmpl-owner/tmpl-repo/generate`, () => {
        generateCalled = true
        return HttpResponse.json({})
      }),
    )

    const url = await makeAdapter().createRepoFromTemplate(CONFIG)
    expect(url).toBe('https://github.com/acme/my-app.git')
    expect(generateCalled).toBe(false)
  })
})
