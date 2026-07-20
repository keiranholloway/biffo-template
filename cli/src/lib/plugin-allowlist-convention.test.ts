import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ALLOWLIST_MAIN_TF,
  ALLOWLIST_VARIABLES_TF,
  COMPUTE_MAIN_TF,
  PLUGIN_TEMPLATE_MAIN_TF,
  checkAllowlistConvention,
  composeExpectedRoleName,
  readAllowlistGlob,
} from './plugin-allowlist-convention.js'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const SOURCES = [
  COMPUTE_MAIN_TF,
  PLUGIN_TEMPLATE_MAIN_TF,
  ALLOWLIST_MAIN_TF,
  ALLOWLIST_VARIABLES_TF,
]

let fixture: string

/** A copy of the real modules, so a test can break one and watch the guard fire. */
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'allowlist-convention-'))
  for (const relative of SOURCES) {
    mkdirSync(dirname(join(fixture, relative)), { recursive: true })
    cpSync(join(REPO_ROOT, relative), join(fixture, relative))
  }
})

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true })
})

function patch(relative: string, from: string, to: string): void {
  const path = join(fixture, relative)
  const before = readFileSync(path, 'utf8')
  expect(before, `${relative} no longer contains ${from}`).toContain(from)
  writeFileSync(path, before.replace(from, to))
}

describe('the real modules', () => {
  it('agree on the plugin role name', () => {
    expect(composeExpectedRoleName(REPO_ROOT)).toBe('<project>-<env>-plugin-<plugin>-role')
    expect(readAllowlistGlob(REPO_ROOT)).toBe(
      'arn:aws:sts::<account>:assumed-role/<project>-<env>-plugin-<plugin>-role/*',
    )
    expect(checkAllowlistConvention(REPO_ROOT)).toEqual([])
  })
})

describe('drift detection', () => {
  it('fires when compute renames the IAM role suffix', () => {
    patch(
      COMPUTE_MAIN_TF,
      'name               = "${local.function_name}-role"',
      'name               = "${local.function_name}-lambda-role"',
    )

    const violations = checkAllowlistConvention(fixture)

    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(ALLOWLIST_MAIN_TF)
    expect(violations[0]?.message).toContain('<project>-<env>-plugin-<plugin>-lambda-role')
  })

  it('fires when compute changes the name prefix', () => {
    patch(
      COMPUTE_MAIN_TF,
      'name_prefix   = "${var.project_name}-${var.environment}"',
      'name_prefix   = "${var.project_name}_${var.environment}"',
    )

    expect(checkAllowlistConvention(fixture)[0]?.message).toContain('<project>_<env>')
  })

  it('fires when the plugin template renames the function', () => {
    patch(
      PLUGIN_TEMPLATE_MAIN_TF,
      'function_name      = "plugin-${var.plugin_name}"',
      'function_name      = "plug-${var.plugin_name}"',
    )

    expect(checkAllowlistConvention(fixture)[0]?.message).toContain('plug-<plugin>-role')
  })

  it('fires when the allowlist glob itself drifts', () => {
    patch(ALLOWLIST_MAIN_TF, '-plugin-${name}-role/*', '-plugins-${name}-role/*')

    expect(checkAllowlistConvention(fixture)[0]?.message).toContain('-plugins-<plugin>-role/*')
  })

  it('fires when enabled_plugins stops defaulting to empty (fail-closed)', () => {
    patch(ALLOWLIST_VARIABLES_TF, 'default     = []', 'default     = ["*"]')

    const violations = checkAllowlistConvention(fixture)

    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(ALLOWLIST_VARIABLES_TF)
    expect(violations[0]?.message).toContain('fail-closed')
  })
})
