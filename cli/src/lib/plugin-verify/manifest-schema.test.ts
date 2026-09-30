import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../../test-utils/tmp.js'
import type { CommandResult, CommandRunner } from '../plugin-compose/command-runner.js'
import { buildManifestSchema, hasNativeSchema } from './manifest-schema.js'

class GeneratorRunner implements CommandRunner {
  calls: Array<{ cmd: string; args: string[] }> = []
  run(cmd: string, args: string[]): CommandResult {
    this.calls.push({ cmd, args })
    // Play the generator: drop one migration into --versions-dir.
    const dir = args[args.indexOf('--versions-dir') + 1]!
    writeFileSync(join(dir, 'abc_create_t.py'), 'revision = "abc"\n')
    return { status: 0, stdout: '' }
  }
}

function plugin(tables: unknown[]) {
  const cwd = makeTmpDir('manifest-schema-plugin')
  writeFileSync(join(cwd, 'biffo.plugin.json'), JSON.stringify({ name: 'demo', tables }))
  const core = makeTmpDir('manifest-schema-core')
  mkdirSync(join(core, 'services', 'api', 'scripts'), { recursive: true })
  writeFileSync(join(core, 'services', 'api', 'scripts', 'generate_plugin_migrations.py'), '')
  return { cwd, core }
}

describe('hasNativeSchema', () => {
  it('is false for a plugin repo and true with db/imports DDL or an alembic.ini', () => {
    const cwd = makeTmpDir('manifest-schema-native')
    expect(hasNativeSchema(cwd)).toBe(false)
    mkdirSync(join(cwd, 'db', 'imports', 'm'), { recursive: true })
    expect(hasNativeSchema(cwd)).toBe(false)
    writeFileSync(join(cwd, 'db', 'imports', 'm', 'a.sql'), '')
    expect(hasNativeSchema(cwd)).toBe(true)
    const other = makeTmpDir('manifest-schema-native2')
    writeFileSync(join(other, 'alembic.ini'), '')
    expect(hasNativeSchema(other)).toBe(true)
  })
})

describe('buildManifestSchema', () => {
  it("runs Core's own plugin migration generator over the manifest and points the script at the result", () => {
    const { cwd, core } = plugin([{ name: 't', columns: [] }])
    const runner = new GeneratorRunner()
    const built = buildManifestSchema(runner, cwd, core)!
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.args.join(' ')).toContain(
      join(core, 'services', 'api', 'scripts', 'generate_plugin_migrations.py'),
    )
    expect(built.env.BIFFO_REPO_ROOT).toBe(cwd)
    expect(built.env.BIFFO_PG_ALEMBIC_PROJECT).toBe(join(core, 'services', 'api'))
    expect(built.env.BIFFO_PG_ALEMBIC_DIR).toContain('alembic')
    expect(
      readdirSync(join(built.env.BIFFO_PG_ALEMBIC_DIR!, 'migrations', 'versions')),
    ).toHaveLength(1)
  })

  it('returns null when the manifest declares no tables', () => {
    const { cwd, core } = plugin([])
    expect(buildManifestSchema(new GeneratorRunner(), cwd, core)).toBeNull()
  })
})
