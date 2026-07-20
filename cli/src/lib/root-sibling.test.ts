import { describe, expect, it } from 'vitest'
import {
  basePathFor,
  bucketRegionalDomain,
  displayPath,
  isRootPathPrefix,
  registryNameFor,
  RESERVED_SIBLING_NAMES,
  rootSiblingProjectName,
  ROOT_SIBLING_NAME,
  serializeRegistry,
  siteBucketName,
  upsertSiblingOrigin,
} from './root-sibling.js'
import { collectSiblings, parseSiblingBucketDomain } from './sibling-teardown.js'

describe('root sibling naming', () => {
  it('reserves "app" alongside the portal\'s own prefixes', () => {
    expect(ROOT_SIBLING_NAME).toBe('app')
    expect(RESERVED_SIBLING_NAMES).toEqual(['admin', 'login', 'app'])
  })

  it('keeps the registry name non-empty when the path prefix is empty', () => {
    expect(isRootPathPrefix('')).toBe(true)
    expect(registryNameFor('')).toBe('app')
    expect(registryNameFor('crm')).toBe('crm')
  })

  it('renders the root path as "/" and never "//"', () => {
    expect(displayPath('')).toBe('/')
    expect(displayPath('crm')).toBe('/crm')
  })

  // Next.js rejects a basePath of "/" outright, so this is a build-breaking
  // distinction, not a cosmetic one.
  it('gives the root sibling an empty basePath, not "/"', () => {
    expect(basePathFor('')).toBe('')
    expect(basePathFor('crm')).toBe('/crm')
  })

  it('derives the app repo name from the core project name', () => {
    expect(rootSiblingProjectName('tabsii')).toBe('tabsii-app')
  })
})

describe('registry entries', () => {
  it('replaces an entry with the same name rather than duplicating it', () => {
    const first = upsertSiblingOrigin([], { name: 'app', bucket_regional_domain: 'a' })
    const second = upsertSiblingOrigin(first, { name: 'app', bucket_regional_domain: 'b' })
    expect(second).toEqual([{ name: 'app', bucket_regional_domain: 'b' }])
  })

  it('leaves other siblings alone', () => {
    const existing = [{ name: 'crm', bucket_regional_domain: 'crm-host' }]
    expect(upsertSiblingOrigin(existing, { name: 'app', bucket_regional_domain: 'app-host' })).toEqual(
      [
        { name: 'crm', bucket_regional_domain: 'crm-host' },
        { name: 'app', bucket_regional_domain: 'app-host' },
      ],
    )
  })

  it('serializes with a trailing newline', () => {
    expect(serializeRegistry([])).toBe('{\n  "sibling_origins": []\n}\n')
  })
})

// The constraint that makes the whole "empty prefix, non-empty name" split
// necessary: teardown keys siblings by the registry name, and a sibling it
// cannot key is a sibling it silently leaves behind, still billing.
describe('teardown can still discover a root sibling', () => {
  const domain = bucketRegionalDomain(
    siteBucketName(rootSiblingProjectName('my-app'), 'dev', '123456789012'),
    'eu-west-1',
  )

  it('recovers the project name, environment and account from its bucket', () => {
    expect(parseSiblingBucketDomain(domain)).toEqual({
      projectName: 'my-app-app',
      environment: 'dev',
      accountId: '123456789012',
    })
  })

  it('collects it exactly like any other sibling', () => {
    const [sibling] = collectSiblings([
      {
        environment: 'dev',
        entries: [{ name: ROOT_SIBLING_NAME, bucket_regional_domain: domain }],
      },
    ])

    expect(sibling).toMatchObject({
      pathPrefix: 'app',
      projectName: 'my-app-app',
      environments: ['dev'],
      accountId: '123456789012',
      registered: true,
    })
  })

  it('refuses an entry whose name was left empty', () => {
    expect(() =>
      collectSiblings([
        { environment: 'dev', entries: [{ name: '', bucket_regional_domain: domain }] },
      ]),
    ).toThrow(/missing name or bucket_regional_domain/)
  })
})
