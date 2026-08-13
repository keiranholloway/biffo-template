import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pluginSeedImportDir, vendorPluginSeed } from './plugin-seed-vendor.js'
import { makeTmpDir } from '../test-utils/tmp.js'

describe('pluginSeedImportDir', () => {
  it('prefixes with an underscore, which biffo data import can never produce', () => {
    // data-import.ts's NAME_PATTERN is /^[a-z][a-z0-9-]*$/ — it requires the
    // first character to be a-z, so it can never start with `_`. This is the
    // whole collision-avoidance argument; assert the shape directly so a
    // future rename of the prefix has to consciously re-justify it.
    expect(pluginSeedImportDir('widgets')).toBe('db/imports/_plugin-widgets')
    expect(pluginSeedImportDir('widgets')).toMatch(/^db\/imports\/_/)
  })
})

describe('vendorPluginSeed', () => {
  let sourceDir: string
  let cwd: string

  beforeEach(() => {
    sourceDir = makeTmpDir('biffo-plugin-src')
    cwd = makeTmpDir('biffo-project')
  })

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  it('is a no-op — no directory created, nothing staged — when the manifest declares no seed', () => {
    const result = vendorPluginSeed(sourceDir, { name: 'widgets', seed: undefined }, cwd)

    expect(result).toEqual({ vendored: false })
    expect(existsSync(join(cwd, 'db', 'imports'))).toBe(false)
  })

  it('copies every *.sql file directly under seed.dir, non-recursively, into db/imports/_plugin-<name>/', () => {
    mkdirSync(join(sourceDir, 'db', 'seed'), { recursive: true })
    writeFileSync(join(sourceDir, 'db', 'seed', '000_first.sql'), 'INSERT 1;\n')
    writeFileSync(join(sourceDir, 'db', 'seed', '001_second.sql'), 'INSERT 2;\n')
    writeFileSync(join(sourceDir, 'db', 'seed', 'README.md'), 'not sql, must not be copied\n')
    // A subdirectory's .sql file must NOT be picked up — matches
    // discover_ddl_import_dirs/list_sql_files's non-recursive glob("*.sql").
    mkdirSync(join(sourceDir, 'db', 'seed', 'nested'), { recursive: true })
    writeFileSync(join(sourceDir, 'db', 'seed', 'nested', '999_deep.sql'), 'INSERT 3;\n')

    const result = vendorPluginSeed(
      sourceDir,
      { name: 'widgets', seed: { dir: 'db/seed', baseline_tables: ['widgets_items'] } },
      cwd,
    )

    expect(result).toEqual({ vendored: true, stagedPath: 'db/imports/_plugin-widgets' })
    const targetDir = join(cwd, 'db', 'imports', '_plugin-widgets')
    expect(readFileSync(join(targetDir, '000_first.sql'), 'utf8')).toBe('INSERT 1;\n')
    expect(readFileSync(join(targetDir, '001_second.sql'), 'utf8')).toBe('INSERT 2;\n')
    expect(existsSync(join(targetDir, 'README.md'))).toBe(false)
    expect(existsSync(join(targetDir, '999_deep.sql'))).toBe(false)
  })

  it('throws when seed.dir is declared but does not exist in the plugin source', () => {
    expect(() =>
      vendorPluginSeed(
        sourceDir,
        { name: 'widgets', seed: { dir: 'db/seed', baseline_tables: [] } },
        cwd,
      ),
    ).toThrow(/seed\.dir 'db\/seed'/)
  })

  it('throws when seed.dir exists but contains no .sql files', () => {
    mkdirSync(join(sourceDir, 'db', 'seed'), { recursive: true })
    writeFileSync(join(sourceDir, 'db', 'seed', 'README.md'), 'no sql here\n')

    expect(() =>
      vendorPluginSeed(
        sourceDir,
        { name: 'widgets', seed: { dir: 'db/seed', baseline_tables: [] } },
        cwd,
      ),
    ).toThrow(/contains no \*\.sql files/)
  })

  it('fully replaces an existing vendored directory rather than merging old and new files', () => {
    const targetDir = join(cwd, 'db', 'imports', '_plugin-widgets')
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'old_stale.sql'), '-- from a previous version\n')

    mkdirSync(join(sourceDir, 'db', 'seed'), { recursive: true })
    writeFileSync(join(sourceDir, 'db', 'seed', '001_new.sql'), 'INSERT 1;\n')

    vendorPluginSeed(
      sourceDir,
      { name: 'widgets', seed: { dir: 'db/seed', baseline_tables: [] } },
      cwd,
    )

    expect(existsSync(join(targetDir, 'old_stale.sql'))).toBe(false)
    expect(existsSync(join(targetDir, '001_new.sql'))).toBe(true)
  })
})
