// Minimal static file server for the Next.js static export (output: 'export').
//
// The export is built with the sibling's basePath, so every emitted asset URL is
// prefixed with /crm — but the files themselves live at the `out/` ROOT (Next
// does not nest the export under the basePath directory). In production the
// parent CloudFront distribution syncs `out/` into the sibling's S3 prefix; here we
// reproduce the same effect by stripping the leading the base path from each request
// path before resolving it against `out/`.
import { createServer } from 'node:http'

import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../out/', import.meta.url))
const BASE_PATH = process.env.E2E_BASE_PATH || process.env.NEXT_PUBLIC_BASE_PATH || ''
const PORT = Number(process.env.E2E_PORT || 4321)

// The document the CORE portal publishes at runtime (#403/#400) — auth.ts's
// identity.ts resolves the Cognito pool from this instead of a baked
// NEXT_PUBLIC_CORE_COGNITO_* build var. Real deployments serve it same-origin
// from the portal's own bucket; here it stands in for that, sourced from the
// SAME E2E_COGNITO_* values playwright.config.ts derives from e2e/fixtures.ts,
// so the pool/client id this document advertises always matches the one
// e2e/session.ts used to seed the localStorage session.
const IDENTITY_DOCUMENT_PATH = '/.well-known/biffo-identity.json'
const IDENTITY_DOCUMENT = JSON.stringify({
  userPoolId: process.env.E2E_COGNITO_USER_POOL_ID || '',
  clientId: process.env.E2E_COGNITO_CLIENT_ID || '',
})

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
}

async function resolveFile(urlPath) {
  // Strip the sibling base path: the files live at out/ root.
  let p = urlPath
  if (p === BASE_PATH) p = '/'
  else if (p.startsWith(`${BASE_PATH}/`)) p = p.slice(BASE_PATH.length)
  if (p.endsWith('/')) p += 'index.html'

  // Block path traversal, then resolve against ROOT.
  const rel = normalize(p).replace(/^(\.\.[/\\])+/, '')
  let filePath = join(ROOT, rel)

  let s = await stat(filePath).catch(() => null)
  if (s?.isDirectory()) {
    filePath = join(filePath, 'index.html')
    s = await stat(filePath).catch(() => null)
  }
  if (!s) {
    // Extensionless route (trailingSlash export also emits foo/index.html).
    const alt = `${filePath}.html`
    if (await stat(alt).catch(() => null)) return alt
    return null
  }
  return filePath
}

/** Read a JSON request body, tolerating an empty one. */

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const urlPath = decodeURIComponent(url.pathname)

      // The core identity document, served ROOT-relative and same-origin —
      // NOT under BASE_PATH, matching how the real portal publishes it and
      // how identity.ts fetches it (an absolute `/.well-known/...` path).
      if (urlPath === IDENTITY_DOCUMENT_PATH) {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(IDENTITY_DOCUMENT)
        return
      }

      // Where a sibling's Core-API fixtures go, if it needs them. Under E2E
      // `NEXT_PUBLIC_API_URL` is '', so the app's Core-API calls are
      // same-origin relative paths and arrive here. Add an `api-fixtures.mjs`
      // beside this file and dispatch to it before the static fallback below —
      // tabsii-crm's is the worked example. A sibling with no BFF calls needs
      // nothing here.

      const filePath = await resolveFile(urlPath)
      if (!filePath) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not found')
        return
      }
      const body = await readFile(filePath)
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(filePath)] || 'application/octet-stream',
        'cache-control': 'no-store',
      })
      res.end(body)
    } catch (err) {
      // The detail goes to stderr, not to the caller: Playwright captures this
      // webServer's output, so whoever is debugging still sees the whole error,
      // and the response body stays bounded (js/stack-trace-exposure, #1223).
      console.error('[e2e-static-server]', err)
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('Internal error')
    }
  })()
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`static-server: http://127.0.0.1:${PORT}${BASE_PATH}/ (root: ${ROOT})\n`)
})
