import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BiffoConfigSchema } from '../config/schema.js'
import { SiblingConfigSchema } from '../config/sibling-schema.js'
import { runSiblingCreate, writeSiblingTemplate } from './sibling-create.js'

vi.mock('../lib/logger.js', () => ({
  log: { step: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const CORE_CONFIG = BiffoConfigSchema.parse({
  project: { name: 'core-app', description: 'Core app' },
  dns: { mode: 'none' },
  source_control: { provider: 'github', config: { org: 'acme', repo: 'core-app' } },
  cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
  environments: ['dev'],
  admin: { email: 'admin@example.com', username: 'admin' },
})

const SIBLING_CONFIG = SiblingConfigSchema.parse({
  project: { name: 'reports', description: 'Reports sibling' },
  source_control: { provider: 'github', config: { org: 'acme', repo: 'reports' } },
  cloud: { provider: 'aws', config: { account_id: '123456789012', region: 'eu-west-1' } },
  environments: ['dev'],
  core: { config_path: './biffo.config.json', path_prefix: 'reports' },
})

describe('writeSiblingTemplate', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('rewrites sibling metadata and frontend env defaults', () => {
    const template = mkdtempSync(join(tmpdir(), 'sibling-template-'))
    const target = mkdtempSync(join(tmpdir(), 'sibling-target-'))
    dirs.push(template, target)
    writeFileSync(
      join(template, 'biffo.sibling.json'),
      JSON.stringify({ name: 'example-sibling', core_project: 'example-core-project' }),
    )
    const frontendDir = join(template, 'apps', 'frontend')
    // Keep the fixture tiny; writeSiblingTemplate only requires this path when present.
    mkdirSync(frontendDir, { recursive: true })
    writeFileSync(
      join(frontendDir, '.env.example'),
      [
        'NEXT_PUBLIC_SIBLING_NAME=example-sibling',
        'NEXT_PUBLIC_SIBLING_PATH_PREFIX=/example-sibling',
        'NEXT_PUBLIC_BASE_PATH=/example-sibling',
      ].join('\n'),
    )

    writeSiblingTemplate(template, target, SIBLING_CONFIG, {
      coreProjectName: 'core-app',
      pathPrefix: 'reports',
    })

    expect(JSON.parse(readFileSync(join(target, 'biffo.sibling.json'), 'utf8'))).toMatchObject({
      name: 'reports',
      core_project: 'core-app',
      path_prefix: 'reports',
      description: 'Reports sibling',
    })
    expect(readFileSync(join(target, 'apps', 'frontend', '.env.example'), 'utf8')).toContain(
      'NEXT_PUBLIC_SIBLING_NAME=reports',
    )
  })
})

describe('runSiblingCreate', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('supports config-driven dry runs without calling live deps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sibling-create-'))
    dirs.push(dir)
    const configPath = join(dir, 'biffo.sibling.json')
    const corePath = join(dir, 'biffo.config.json')
    writeFileSync(configPath, JSON.stringify(SIBLING_CONFIG))
    writeFileSync(corePath, JSON.stringify(CORE_CONFIG))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      await runSiblingCreate('reports', {
        configPath,
        templateRoot: join(dir, 'template'),
        dryRun: true,
      })
    } finally {
      log.mockRestore()
    }
  })
})
