import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTmpDir } from '../test-utils/tmp.js'
import {
  API_ROUTE_PREFIX,
  assertSiblingCoreDirectPaths,
  auditCoreRouteExtraction,
  auditFrontendExtraction,
  auditSiblingCoreDirectPaths,
  coreSourceFiles,
  countRawExternalOccurrences,
  extractCoreDirectPaths,
  extractCoreRoutePrefixes,
  frontendSourceFiles,
  pathMatchesAnyCorePrefix,
  resolveSiblingCoreSrc,
} from './core-direct-paths-audit.js'

// ── extractCoreDirectPaths ──────────────────────────────────────────────────

describe('extractCoreDirectPaths', () => {
  it('extracts a plain literal prefixed with the declared external base', () => {
    const found = extractCoreDirectPaths(
      'const url = `${CORE_API_URL}/api/v1/public/demo-requests`',
      'x.ts',
    )
    expect(found).toHaveLength(1)
    expect(found[0].normalized).toBe('/api/v1/public/demo-requests')
    expect(found[0].unresolvedReason).toBeNull()
    expect(found[0].externalBase).toBe('CORE_API_URL')
  })

  it('ignores a literal not prefixed with a declared external identifier', () => {
    // The BASE-variable-reuse shape real in tabsii-intake
    // (`${BASE}/${token}`) — out of scope by definition, see module docstring.
    const found = extractCoreDirectPaths('fetch(`${BASE}/${token}`)', 'x.ts')
    expect(found).toEqual([])
  })

  it('ignores an ordinary same-repo BFF-relative literal', () => {
    const found = extractCoreDirectPaths("fetch('/api/v1/whoami')", 'x.ts')
    expect(found).toEqual([])
  })

  it('normalises interpolations inside the path to {param}', () => {
    const found = extractCoreDirectPaths(
      'fetch(`${CORE_API_URL}/api/v1/public/leads/${encodeURIComponent(brandSlug)}`)',
      'x.ts',
    )
    expect(found).toHaveLength(1)
    expect(found[0].normalized).toBe('/api/v1/public/leads/{param}')
  })

  it('strips a literal query string, which cannot change which route is hit', () => {
    const found = extractCoreDirectPaths(
      'fetch(`${CORE_API_URL}/api/v1/public/marketplace/brands?active=true`)',
      'x.ts',
    )
    expect(found[0].normalized).toBe('/api/v1/public/marketplace/brands')
  })

  it('treats string concatenation as unresolved, not skipped', () => {
    const found = extractCoreDirectPaths('fetch(`${CORE_API_URL}/api/v1/public/x/` + id)', 'x.ts')
    expect(found).toHaveLength(1)
    expect(found[0].normalized).toBeNull()
    expect(found[0].unresolvedReason).toMatch(/concatenation/)
  })

  it('resolves a nested template literal rather than truncating it', () => {
    // A brace/backtick-naive regex stops at the FIRST closing backtick, which
    // is the inner one here — this scanner tracks depth instead.
    const found = extractCoreDirectPaths(
      "fetch(`${CORE_API_URL}/api/v1/public/x/${id}${cond ? `?limit=${n}` : ''}`)",
      'x.ts',
    )
    expect(found).toHaveLength(1)
    expect(found[0].unresolvedReason).toBeNull()
    expect(found[0].normalized).toBe('/api/v1/public/x/{param}{param}')
  })

  it('does not mistake a path merely named in a line comment for a call site', () => {
    const found = extractCoreDirectPaths(
      '// see `${CORE_API_URL}/api/v1/public/legacy` for the old shape\n' +
        'fetch(`${CORE_API_URL}/api/v1/public/demo-requests`)',
      'x.ts',
    )
    expect(found).toHaveLength(1)
    expect(found[0].normalized).toBe('/api/v1/public/demo-requests')
  })

  it('does not mistake a path merely named in a block comment for a call site', () => {
    const found = extractCoreDirectPaths(
      '/** deprecated: used to hit `${CORE_API_URL}/api/v1/public/legacy` */\n' +
        'fetch(`${CORE_API_URL}/api/v1/public/demo-requests`)',
      'x.ts',
    )
    expect(found).toHaveLength(1)
  })

  /**
   * #1374, reduced from `tabsii-geo`'s `MapView.tsx` verbatim (the shape the
   * adjacent #1330 guard was blinded by): a `/*` appearing as PROSE inside a
   * `//` line comment must not be read as a real block-comment opener by a
   * two-pass stripper. This guard uses a single alternation for exactly this
   * reason — proving it here, not just trusting the comment in the source.
   */
  it('a block-comment opener inside a line comment eats nothing after it', () => {
    const found = extractCoreDirectPaths(
      '// exclude everything under basemap/*) from the S3 deploy\n' +
        'fetch(`${CORE_API_URL}/api/v1/public/demo-requests`)\n' +
        'fetch(`${CORE_API_URL}/api/v1/public/disclosures`)\n' +
        '{/* an ordinary JSX comment */}\n' +
        'fetch(`${CORE_API_URL}/api/v1/public/discovery-days`)\n',
      'MapView.tsx',
    )
    expect(found.map((p) => p.normalized)).toEqual([
      '/api/v1/public/demo-requests',
      '/api/v1/public/disclosures',
      '/api/v1/public/discovery-days',
    ])
  })

  it('only names identifiers explicitly declared external', () => {
    const found = extractCoreDirectPaths(
      'fetch(`${SOME_OTHER_URL}/api/v1/public/demo-requests`)',
      'x.ts',
    )
    expect(found).toEqual([])
  })

  it('respects a caller-supplied external base list', () => {
    const found = extractCoreDirectPaths('fetch(`${PLATFORM_API_URL}/api/v1/public/x`)', 'x.ts', [
      'PLATFORM_API_URL',
    ])
    expect(found).toHaveLength(1)
    expect(found[0].externalBase).toBe('PLATFORM_API_URL')
  })
})

// ── countRawExternalOccurrences (the blindness backstop's raw half) ────────

describe('countRawExternalOccurrences', () => {
  it('counts every literal ${CORE_API_URL} occurrence, unaffected by comment stripping', () => {
    const text =
      'fetch(`${CORE_API_URL}/api/v1/public/a`)\nfetch(`${CORE_API_URL}/api/v1/public/b`)\n'
    expect(countRawExternalOccurrences(text)).toBe(2)
  })

  it('is zero on a file with no external-base interpolation', () => {
    expect(countRawExternalOccurrences("fetch('/api/v1/whoami')")).toBe(0)
  })
})

// ── extractCoreRoutePrefixes ────────────────────────────────────────────────

describe('extractCoreRoutePrefixes', () => {
  it('extracts a simple prefix', () => {
    const { prefixes, rawApiRouterCount } = extractCoreRoutePrefixes(
      'router = APIRouter(prefix="/public/demo-requests", tags=["public"])\n',
    )
    expect(prefixes).toEqual(['/public/demo-requests'])
    expect(rawApiRouterCount).toBe(1)
  })

  it('extracts multiple routers from one file', () => {
    const { prefixes, rawApiRouterCount } = extractCoreRoutePrefixes(
      'router = APIRouter(prefix="/public/disclosures", tags=["public"])\n' +
        'admin_router = APIRouter(prefix="/admin/disclosures", tags=["admin"])\n',
    )
    expect(prefixes.sort()).toEqual(['/admin/disclosures', '/public/disclosures'])
    expect(rawApiRouterCount).toBe(2)
  })

  it('counts a router with no prefix= in the raw total, but extracts no prefix for it', () => {
    const { prefixes, rawApiRouterCount } = extractCoreRoutePrefixes(
      'router = APIRouter(tags=["public"])\n',
    )
    expect(prefixes).toEqual([])
    expect(rawApiRouterCount).toBe(1)
  })

  it('is not confused by other parenthesised calls on the same line', () => {
    const { prefixes } = extractCoreRoutePrefixes(
      'router = APIRouter(prefix=build_prefix("x"), tags=["public"])\n' +
        'other = APIRouter(prefix="/public/leads")\n',
    )
    // The first router's prefix is computed, not a literal -- extracted as no
    // prefix (conservative: never invents a match), the second is literal.
    expect(prefixes).toEqual(['/public/leads'])
  })
})

// ── pathMatchesAnyCorePrefix ────────────────────────────────────────────────

describe('pathMatchesAnyCorePrefix', () => {
  it('matches a path equal to a registered prefix', () => {
    expect(pathMatchesAnyCorePrefix('/api/v1/public/disclosures', ['/public/disclosures'])).toBe(
      true,
    )
  })

  it('matches a path that extends a registered prefix with a sub-path', () => {
    expect(pathMatchesAnyCorePrefix('/api/v1/public/leads/{param}', ['/public/leads'])).toBe(true)
  })

  it('rejects a path with no registered prefix at all', () => {
    expect(pathMatchesAnyCorePrefix('/api/v1/public/finance', ['/public/disclosures'])).toBe(false)
  })

  it('does not treat a prefix as a substring match across a segment boundary', () => {
    // /api/v1/public must not match a route registered only at /public-extra
    expect(pathMatchesAnyCorePrefix('/api/v1/public', ['/public-extra'])).toBe(false)
    expect(pathMatchesAnyCorePrefix('/api/v1/publicity', ['/public'])).toBe(false)
  })

  it('honours a caller-supplied API route prefix', () => {
    expect(pathMatchesAnyCorePrefix('/v2/public/x', ['/public/x'], '/v2')).toBe(true)
  })
})

// ── Filesystem discovery ────────────────────────────────────────────────────

describe('frontendSourceFiles and coreSourceFiles', () => {
  it('excludes frontend test files', () => {
    const dir = makeTmpDir('core-direct-fe')
    mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
    writeFileSync(join(dir, 'src', 'lib', 'demo-requests.ts'), '// real')
    writeFileSync(join(dir, 'src', 'lib', 'demo-requests.test.ts'), '// mock')
    const files = frontendSourceFiles(join(dir, 'src'))
    expect(files).toEqual([join(dir, 'src', 'lib', 'demo-requests.ts')])
  })

  it('excludes core Python test modules and __pycache__', () => {
    const dir = makeTmpDir('core-direct-api')
    mkdirSync(join(dir, 'domains', 'tabsii', 'tests'), { recursive: true })
    mkdirSync(join(dir, 'domains', 'tabsii', '__pycache__'), { recursive: true })
    writeFileSync(join(dir, 'domains', 'tabsii', 'demo_requests.py'), '# real')
    writeFileSync(join(dir, 'domains', 'tabsii', 'tests', 'test_demo_requests.py'), '# test')
    writeFileSync(join(dir, 'domains', 'tabsii', '__pycache__', 'demo_requests.pyc'), 'junk')
    const files = coreSourceFiles(dir)
    expect(files).toEqual([join(dir, 'domains', 'tabsii', 'demo_requests.py')])
  })
})

// ── auditFrontendExtraction / auditCoreRouteExtraction ──────────────────────

describe('auditFrontendExtraction', () => {
  it('extracts a non-zero count on realistic multi-file input (proof it is not trivially blind)', () => {
    // Mirrors tabsii-intake's actual shape at origin/dev, 2026-08-09: six
    // files each declaring a BASE off CORE_API_URL, one inlining it directly.
    const dir = makeTmpDir('core-direct-real')
    mkdirSync(join(dir, 'lib'), { recursive: true })
    const files: Record<string, string> = {
      'demo-requests.ts':
        "const CORE_API_URL = process.env['NEXT_PUBLIC_CORE_API_URL'] ?? ''\n" +
        'fetch(`${CORE_API_URL}/api/v1/public/demo-requests`)\n',
      'disclosures.ts':
        "const CORE_API_URL = process.env['NEXT_PUBLIC_CORE_API_URL'] ?? ''\n" +
        'const BASE = `${CORE_API_URL}/api/v1/public/disclosures`\n',
      'discovery-days.ts':
        "const CORE_API_URL = process.env['NEXT_PUBLIC_CORE_API_URL'] ?? ''\n" +
        'const BASE = `${CORE_API_URL}/api/v1/public/discovery-days`\n',
      'public-leads.ts':
        "const CORE_API_URL = process.env['NEXT_PUBLIC_CORE_API_URL'] ?? ''\n" +
        'const MARKETPLACE_BASE = `${CORE_API_URL}/api/v1/public/marketplace`\n' +
        'fetch(`${CORE_API_URL}/api/v1/public/leads/${encodeURIComponent(brandSlug)}`)\n',
      'signatures.ts':
        "const CORE_API_URL = process.env['NEXT_PUBLIC_CORE_API_URL'] ?? ''\n" +
        'const BASE = `${CORE_API_URL}/api/v1/public/signatures`\n',
      'unsubscribe.ts':
        "const CORE_API_URL = process.env['NEXT_PUBLIC_CORE_API_URL'] ?? ''\n" +
        'const BASE = `${CORE_API_URL}/api/v1/public/unsubscribe`\n',
    }
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, 'lib', name), content)
    }
    const result = auditFrontendExtraction(join(dir))
    expect(result.extracted).toHaveLength(7)
    expect(result.rawTotal).toBe(7)
  })

  it('rawTotal exceeding extracted count is the blindness signal auditSiblingCoreDirectPaths acts on', () => {
    // Direct proof of the backstop's arithmetic, independent of whether
    // today's extractor happens to have a bug: rawTotal counts textually,
    // extracted comes from the (separately tested) scanner -- if a future
    // change to stripComments/templateLiterals ever swallows real content,
    // this is the fact that catches it.
    const dir = makeTmpDir('core-direct-blind')
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(
      join(dir, 'lib', 'x.ts'),
      'fetch(`${CORE_API_URL}/api/v1/public/demo-requests`)\n',
    )
    const result = auditFrontendExtraction(join(dir))
    expect(result.rawTotal).toBeGreaterThan(0)
    expect(result.extracted.length).toBe(result.rawTotal)
  })
})

describe('auditCoreRouteExtraction', () => {
  it('extracts registered prefixes across multiple domain files', () => {
    const dir = makeTmpDir('core-direct-routes')
    mkdirSync(join(dir, 'domains', 'tabsii'), { recursive: true })
    writeFileSync(
      join(dir, 'domains', 'tabsii', 'demo_requests.py'),
      'router = APIRouter(prefix="/public/demo-requests", tags=["public"])\n',
    )
    writeFileSync(
      join(dir, 'domains', 'tabsii', 'public_disclosure.py'),
      'router = APIRouter(prefix="/public/disclosures", tags=["public"])\n',
    )
    const result = auditCoreRouteExtraction(dir)
    expect(result.prefixes.sort()).toEqual(['/public/demo-requests', '/public/disclosures'])
    expect(result.rawApiRouterCount).toBe(2)
  })
})

// ── auditSiblingCoreDirectPaths / assertSiblingCoreDirectPaths ─────────────

function buildFixture(dirPrefix: string) {
  const dir = makeTmpDir(dirPrefix)
  const frontendSrcDir = join(dir, 'apps', 'frontend', 'src')
  const coreApiSrcDir = join(dir, 'core-api')
  mkdirSync(join(frontendSrcDir, 'lib'), { recursive: true })
  mkdirSync(join(coreApiSrcDir, 'domains'), { recursive: true })
  return { dir, frontendSrcDir, coreApiSrcDir }
}

describe('auditSiblingCoreDirectPaths', () => {
  it('reports ok when every core-direct call site matches a registered core prefix', () => {
    const { frontendSrcDir, coreApiSrcDir } = buildFixture('core-direct-ok')
    writeFileSync(
      join(frontendSrcDir, 'lib', 'demo-requests.ts'),
      "const CORE_API_URL = ''\nfetch(`${CORE_API_URL}/api/v1/public/demo-requests`)\n",
    )
    writeFileSync(
      join(coreApiSrcDir, 'domains', 'demo_requests.py'),
      'router = APIRouter(prefix="/public/demo-requests", tags=["public"])\n',
    )
    const report = auditSiblingCoreDirectPaths({
      sibling: 'test-sibling',
      frontendSrcDir,
      coreApiSrcDir,
    })
    expect(report.ok).toBe(true)
    expect(report.extractedCount).toBe(1)
    expect(report.matchedCount).toBe(1)
    expect(report.unmatched).toEqual([])
    expect(report.unresolved).toEqual([])
    expect(() =>
      assertSiblingCoreDirectPaths({ sibling: 'test-sibling', frontendSrcDir, coreApiSrcDir }),
    ).not.toThrow()
  })

  it('fails when a core-direct call site names a route core does not register — the #1377 shape', () => {
    const { frontendSrcDir, coreApiSrcDir } = buildFixture('core-direct-unmatched')
    writeFileSync(
      join(frontendSrcDir, 'lib', 'finance.ts'),
      "const CORE_API_URL = ''\nfetch(`${CORE_API_URL}/api/v1/public/finance`)\n",
    )
    writeFileSync(
      join(coreApiSrcDir, 'domains', 'demo_requests.py'),
      'router = APIRouter(prefix="/public/demo-requests", tags=["public"])\n',
    )
    const report = auditSiblingCoreDirectPaths({
      sibling: 'test-sibling',
      frontendSrcDir,
      coreApiSrcDir,
    })
    expect(report.ok).toBe(false)
    expect(report.unmatched).toHaveLength(1)
    expect(report.unmatched[0].normalized).toBe('/api/v1/public/finance')
    expect(() =>
      assertSiblingCoreDirectPaths({ sibling: 'test-sibling', frontendSrcDir, coreApiSrcDir }),
    ).toThrow(/UNMATCHED/)
  })

  it('fails on an unresolved call site rather than silently excluding it', () => {
    const { frontendSrcDir, coreApiSrcDir } = buildFixture('core-direct-unresolved')
    writeFileSync(
      join(frontendSrcDir, 'lib', 'x.ts'),
      "const CORE_API_URL = ''\nfetch(`${CORE_API_URL}/api/v1/public/x/` + id)\n",
    )
    writeFileSync(
      join(coreApiSrcDir, 'domains', 'x.py'),
      'router = APIRouter(prefix="/public/x", tags=["public"])\n',
    )
    const report = auditSiblingCoreDirectPaths({
      sibling: 'test-sibling',
      frontendSrcDir,
      coreApiSrcDir,
    })
    expect(report.ok).toBe(false)
    expect(report.unresolved).toHaveLength(1)
    expect(() =>
      assertSiblingCoreDirectPaths({ sibling: 'test-sibling', frontendSrcDir, coreApiSrcDir }),
    ).toThrow(/UNRESOLVED/)
  })

  it('a repo with no core-direct call sites at all is an honest clean, not blindness', () => {
    const { frontendSrcDir, coreApiSrcDir } = buildFixture('core-direct-clean')
    writeFileSync(join(frontendSrcDir, 'lib', 'x.ts'), "fetch('/api/v1/whoami')\n")
    writeFileSync(join(coreApiSrcDir, 'domains', 'x.py'), 'router = APIRouter(prefix="/whoami")\n')
    const report = auditSiblingCoreDirectPaths({
      sibling: 'test-sibling',
      frontendSrcDir,
      coreApiSrcDir,
    })
    expect(report.ok).toBe(true)
    expect(report.extractedCount).toBe(0)
    expect(report.frontendBlind).toBe(false)
  })

  it('reports the API_ROUTE_PREFIX constant matches what it actually uses', () => {
    expect(API_ROUTE_PREFIX).toBe('/api/v1')
  })
})

// ── resolveSiblingCoreSrc ────────────────────────────────────────────────────
//
// #1377's second finding: the estate audit's first real run reported nine
// false positives because it compared every sibling against biffo-template's
// OWN core instead of the instance that actually serves it. These tests
// exercise the resolver that reads `biffo.sibling.json`'s `core_project`
// directly, rather than reasoning about the fix from the source.

describe('resolveSiblingCoreSrc', () => {
  it("resolves a sibling's core_project to its instance's services/api/src", () => {
    const estateDir = makeTmpDir('resolve-core-ok')
    mkdirSync(join(estateDir, 'tabsii-intake'), { recursive: true })
    writeFileSync(
      join(estateDir, 'tabsii-intake', 'biffo.sibling.json'),
      JSON.stringify({ name: 'tabsii-intake', core_project: 'tabsii-platform' }),
    )
    mkdirSync(join(estateDir, 'tabsii-platform', 'services', 'api', 'src'), { recursive: true })

    const resolution = resolveSiblingCoreSrc({ estateDir, sibling: 'tabsii-intake' })

    expect(resolution.coreProject).toBe('tabsii-platform')
    expect(resolution.coreApiSrcDir).toBe(
      join(estateDir, 'tabsii-platform', 'services', 'api', 'src'),
    )
  })

  it('throws rather than falling back to any default when biffo.sibling.json is missing', () => {
    const estateDir = makeTmpDir('resolve-core-no-config')
    mkdirSync(join(estateDir, 'orphan-sibling'), { recursive: true })

    expect(() => resolveSiblingCoreSrc({ estateDir, sibling: 'orphan-sibling' })).toThrow(
      /biffo\.sibling\.json/,
    )
  })

  it('throws on unparsable JSON rather than silently skipping the sibling', () => {
    const estateDir = makeTmpDir('resolve-core-bad-json')
    mkdirSync(join(estateDir, 'broken-sibling'), { recursive: true })
    writeFileSync(join(estateDir, 'broken-sibling', 'biffo.sibling.json'), '{ not json')

    expect(() => resolveSiblingCoreSrc({ estateDir, sibling: 'broken-sibling' })).toThrow(
      /not valid JSON/,
    )
  })

  it('throws when core_project is absent or blank, never silently picks a fallback', () => {
    const estateDir = makeTmpDir('resolve-core-blank')
    mkdirSync(join(estateDir, 'blank-sibling'), { recursive: true })
    writeFileSync(
      join(estateDir, 'blank-sibling', 'biffo.sibling.json'),
      JSON.stringify({ name: 'blank-sibling', core_project: '' }),
    )

    expect(() => resolveSiblingCoreSrc({ estateDir, sibling: 'blank-sibling' })).toThrow(
      /core_project/,
    )
  })

  it("fails loud — never silently skips — when the named core_project's instance isn't in this checkout", () => {
    // This is exactly the failure mode #1377's fix must not recreate: an
    // unresolvable core is reported as a failure, not folded into a quieter
    // passing run that shrinks the audit's own denominator.
    const estateDir = makeTmpDir('resolve-core-missing-instance')
    mkdirSync(join(estateDir, 'tabsii-marketplace'), { recursive: true })
    writeFileSync(
      join(estateDir, 'tabsii-marketplace', 'biffo.sibling.json'),
      JSON.stringify({ name: 'tabsii-marketplace', core_project: 'tabsii-platform' }),
    )
    // tabsii-platform is deliberately NOT cloned into this estate.

    expect(() => resolveSiblingCoreSrc({ estateDir, sibling: 'tabsii-marketplace' })).toThrow(
      /tabsii-platform.*does not exist/s,
    )
  })
})

// ── disagreement test: class #1362, instance #9 ─────────────────────────────
//
// The guard's two candidate documents are `biffo-template`'s own route
// registrations (what the manifest/naive caller would reach for first — it is
// the only core source this repo, or a caller pointed at it, has on hand) and
// the INSTANCE's route registrations (what actually answers the sibling's
// HTTP request in production: the template's routes PLUS that instance's own
// `domains/<name>/` routes). #1377's first real run used the former for every
// sibling and produced 9/9 false positives; nothing here samples that
// agreement — this constructs a route the template has NEVER registered and
// that only the resolved instance carries, then asserts the audit disagrees
// with the template and agrees with the instance found via
// `resolveSiblingCoreSrc`.
describe('disagreement: the audit must follow the RESOLVED INSTANCE, not the template it was scaffolded from (#1377, class #1362)', () => {
  it('a sibling call site matching only an instance-added domain route fails against the template and passes against the resolved instance', () => {
    const estateDir = makeTmpDir('core-direct-disagreement')

    // The sibling frontend: one core-direct call site, to a route that this
    // fixture's "template" core never registers.
    const frontendSrcDir = join(estateDir, 'test-sibling', 'apps', 'frontend', 'src')
    mkdirSync(join(frontendSrcDir, 'lib'), { recursive: true })
    writeFileSync(
      join(frontendSrcDir, 'lib', 'demo-requests.ts'),
      "const CORE_API_URL = ''\nfetch(`${CORE_API_URL}/api/v1/public/demo-requests`)\n",
    )
    writeFileSync(
      join(estateDir, 'test-sibling', 'biffo.sibling.json'),
      JSON.stringify({ name: 'test-sibling', core_project: 'test-instance' }),
    )

    // "Document": biffo-template's own core -- registers nothing under
    // /public/. Mirrors the real measurement in #1377's comment: biffo-template
    // registers ZERO /public/ routes.
    const templateApiSrcDir = join(estateDir, 'biffo-template', 'services', 'api', 'src')
    mkdirSync(join(templateApiSrcDir, 'domains'), { recursive: true })
    writeFileSync(join(templateApiSrcDir, 'domains', 'whoami.py'), 'router = APIRouter()\n')

    // "Actor": the instance that ACTUALLY serves test-sibling. It carries the
    // template's routes (none relevant here) plus its own product-domain
    // route the template has never held.
    const instanceApiSrcDir = join(estateDir, 'test-instance', 'services', 'api', 'src')
    mkdirSync(join(instanceApiSrcDir, 'domains'), { recursive: true })
    writeFileSync(join(instanceApiSrcDir, 'domains', 'whoami.py'), 'router = APIRouter()\n')
    writeFileSync(
      join(instanceApiSrcDir, 'domains', 'demo_requests.py'),
      'router = APIRouter(prefix="/public/demo-requests", tags=["public"])\n',
    )

    // Reading the DOCUMENT (template) directly: unmatched -- the #1377 bug,
    // reproduced from first principles rather than merely asserted.
    const againstTemplate = auditSiblingCoreDirectPaths({
      sibling: 'test-sibling',
      frontendSrcDir,
      coreApiSrcDir: templateApiSrcDir,
    })
    expect(againstTemplate.ok).toBe(false)
    expect(againstTemplate.unmatched).toHaveLength(1)
    expect(againstTemplate.unmatched[0].normalized).toBe('/api/v1/public/demo-requests')

    // Reading the ACTOR (the resolved instance, via resolveSiblingCoreSrc --
    // the fix, not a hand-picked directory): ok. The guard must return what
    // the actor actually does, not what the document says.
    const resolution = resolveSiblingCoreSrc({ estateDir, sibling: 'test-sibling' })
    expect(resolution.coreApiSrcDir).toBe(instanceApiSrcDir)
    const againstInstance = auditSiblingCoreDirectPaths({
      sibling: 'test-sibling',
      frontendSrcDir,
      coreApiSrcDir: resolution.coreApiSrcDir,
    })
    expect(againstInstance.ok).toBe(true)
    expect(againstInstance.unmatched).toEqual([])
  })
})
