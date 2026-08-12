import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'

const repoRoot = join(new URL('.', import.meta.url).pathname, '..', '..', '..')

/**
 * The infrastructure-side half of #1459's class, left explicitly unguarded
 * when the git-side half (`create-path-birth-coverage.test.ts` +
 * `plugin-create-birth.test.ts` + `sibling-create-birth.test.ts`) shipped:
 *
 * > instance 3 (#1457) — the Lambda `placeholder.zip` absent on the *first*
 * > `terraform apply` — is fixed but unguarded: nothing exercises a
 * > create-path `terraform apply`, so that shape is unprevented.
 *
 * ## Why this is a static check, not `terraform plan`/`apply`
 *
 * Three options were tried against the real modules before writing this:
 *
 * 1. **`terraform validate` already runs in CI** (`.github/workflows/ci.yml`'s
 *    `Terraform Validate & Security` job, over `modules/` and
 *    `infra/environments/`) — and does NOT catch this shape. Proven directly:
 *    reproducing the pre-#1460 `main.tf` (a `data "archive_file"` whose
 *    `output_path`/`output_base64sha256` feed `aws_lambda_function.filename`/
 *    `source_code_hash`) and running `terraform validate` against it with no
 *    `placeholder.zip` on disk returns `Success! The configuration is valid.`
 *    `validate` never invokes a data source's provider (that happens at
 *    `plan`/`refresh`), so a file a data source would generate is invisible to
 *    it. By contrast, a *direct* `filebase64sha256("literal/path")` call IS
 *    evaluated at `validate` time (also proven directly) — which is exactly
 *    why the fix (#1460) moved to that form: it is validate-checkable, the
 *    data-source indirection never was.
 * 2. **`terraform plan` with no credentials is not a "cheaper subset that
 *    still works"** — it is not feasible at all for these modules. Every real
 *    module (`modules/cloud/aws/compute` included) reads
 *    `data "aws_caller_identity" "current"` / `data "aws_region" "current"`,
 *    which require the AWS provider to authenticate before `plan` can produce
 *    anything. Proven directly: `terraform plan` against the real compute
 *    module with no credential source configured fails immediately with
 *    `No valid credential sources found`, before evaluating any Lambda
 *    resource. A plan-based check would need the same live AWS OIDC role
 *    `deploy-infra.yml` uses — i.e. it is the "requires a real cloud account"
 *    option the issue says not to build.
 * 3. **Even with real credentials, a single-job `plan` would not have
 *    reproduced #1457 anyway** — proven directly (this repo has an AWS
 *    profile configured): `data "archive_file"` writes its zip locally as
 *    part of evaluating the plan, so a plan run in ONE job always finds the
 *    file it just wrote. The bug is specifically that `deploy-infra.yml`
 *    runs `plan-<env>` and `apply-<env>` as **separate jobs on separate
 *    runners**, transporting only `tfplan` — a same-process `plan` can't see
 *    that gap at all, so this option is both infeasible (credentials) and
 *    insufficient (wrong shape) at once.
 *
 * What's left, and what this file implements, is the issue's cheapest
 * option: **enumerate every `.tf` file in the repo and refuse two shapes**,
 * neither of which needs Terraform installed, AWS credentials, or a live
 * apply:
 *
 *   - `filename` / a `file(base64)?(sha256|md5|sha1)(...)` call whose literal
 *     argument resolves (after substituting `${path.module}`) to a path that
 *     is not a git-tracked file — the direct form of #1457's bug (option 1
 *     in the issue).
 *   - any reference to a `data "archive_file"`'s own output attributes
 *     (`data.archive_file.<name>.<attr>`) from anywhere else in the tree —
 *     the indirect form #1457 actually shipped, and the specific rule the
 *     issue names (option 4): a `data "archive_file"` writing a path another
 *     resource reads at apply time is refused outright, regardless of which
 *     attribute is used, because the data source's write and the consuming
 *     resource's read can never be guaranteed to happen on the same runner.
 *
 * Enumeration, not a per-case test: `findTerraformFiles` walks the whole
 * repo, not `modules/cloud/aws/compute/` specifically, so a future plugin,
 * sibling skeleton, or environment root that reintroduces either shape is
 * caught the same way — see "walks both skeletons" below for direct proof
 * the walk reaches trees this rule was not written against.
 */

const IGNORED_DIR_NAMES = new Set(['.git', 'node_modules', '.turbo', 'dist', '.next', '.worktrees'])

function findTerraformFiles(root: string): string[] {
  const results: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_DIR_NAMES.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith('.tf')) {
        results.push(full)
      }
    }
  }
  walk(root)
  return results
}

function isGitTracked(root: string, relPath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relPath], {
      cwd: root,
      stdio: 'pipe',
    })
    return true
  } catch {
    return false
  }
}

/**
 * Resolve an HCL string literal that may contain `${path.module}` to a path
 * relative to `root`. Returns `null` — deliberately out of scope rather than
 * a false positive — when the literal contains any OTHER interpolation
 * (`${var.x}`, `${local.x}`, …): this check can only verify a path it can
 * resolve statically, and a genuinely dynamic filename is a different (and
 * legitimate) pattern this rule has no evidence about.
 *
 * `root` is a parameter rather than always the module-level `repoRoot`
 * because the fail-first fixtures below run this same function against a
 * throwaway temp directory, not this repo.
 */
function resolveLiteralPath(root: string, tfFile: string, literal: string): string | null {
  const withoutModuleRef = literal.replace(/\$\{path\.module\}/g, '')
  if (withoutModuleRef.includes('${')) return null

  const moduleDir = dirname(tfFile)
  const substituted = literal.replace(/\$\{path\.module\}/g, moduleDir)
  const abs = substituted.startsWith('/') ? substituted : resolve(moduleDir, substituted)
  return relative(root, abs)
}

interface Violation {
  file: string
  line: number
  rule: 'archive-file-cross-reference' | 'uncommitted-file-reference'
  message: string
}

/** Strip quoted-string CONTENTS (keeping the quotes) so brace characters that
 * are part of an interpolation like `"${path.module}/x.zip"` don't get
 * counted as real block delimiters. Used only for depth tracking below —
 * the original `line` is still what content regexes run against. */
function forBraceCount(line: string): string {
  return line.replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

function checkTerraformFile(root: string, tfFile: string): Violation[] {
  const relFile = relative(root, tfFile)
  const violations: Violation[] = []
  const lines = readFileSync(tfFile, 'utf8').split('\n')

  const checkLiteral = (literal: string, lineNo: number, source: string): void => {
    const relPath = resolveLiteralPath(root, tfFile, literal)
    if (relPath === null) return
    if (!isGitTracked(root, relPath)) {
      violations.push({
        file: relFile,
        line: lineNo,
        rule: 'uncommitted-file-reference',
        message:
          `${source} references "${relPath}", which is not a git-tracked file. ` +
          'A file consumed via filename/source_code_hash must be committed, not produced by ' +
          'this or a later step — see #1457/#1459.',
      })
    }
  }

  // `archive_file`'s own `source { content = ..., filename = "handler.py" }`
  // sub-block uses `filename` for the NAME an entry gets INSIDE the produced
  // zip, not a path on this filesystem — a real distinct meaning from every
  // other resource's `filename` attribute, which this checker must not treat
  // as a file-path reference. Track brace depth well enough to recognise
  // "currently inside a `source { }` block" and suppress the literal-path
  // rule there; the archive-file-cross-reference rule below is unaffected,
  // since that shape can't occur inside an archive_file's own definition
  // (referencing your own not-yet-computed output would be a dependency
  // cycle Terraform itself rejects).
  let depth = 0
  let sourceBlockDepth: number | null = null

  lines.forEach((line, idx) => {
    const lineNo = idx + 1

    if (sourceBlockDepth === null && /^\s*source\s*\{/.test(line)) {
      sourceBlockDepth = depth
    }
    const insideSourceBlock = sourceBlockDepth !== null

    for (const m of line.matchAll(/data\.archive_file\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_]+/g)) {
      const name = m[1]
      if (!name) continue
      violations.push({
        file: relFile,
        line: lineNo,
        rule: 'archive-file-cross-reference',
        message:
          `references data.archive_file.${name}'s generated output. That file exists only on ` +
          'whichever runner evaluated the data source (plan) and is not guaranteed to exist on ' +
          'the runner that applies it — deploy-infra.yml runs plan/apply as separate jobs on ' +
          'separate self-hosted runners transporting only tfplan (#1457). Commit the artefact ' +
          'and reference it directly instead of generating it via data "archive_file".',
      })
    }

    if (!insideSourceBlock) {
      const filenameMatch = line.match(/^\s*filename\s*=\s*"([^"]*)"\s*$/)
      if (filenameMatch) {
        const literal = filenameMatch[1]
        if (literal !== undefined) checkLiteral(literal, lineNo, 'filename')
      }

      for (const m of line.matchAll(/file(?:base64)?(?:sha256|sha1|md5)\(\s*"([^"]*)"\s*\)/g)) {
        const literal = m[1]
        if (literal !== undefined) checkLiteral(literal, lineNo, 'file hash function call')
      }
    }

    const counted = forBraceCount(line)
    const opens = (counted.match(/\{/g) ?? []).length
    const closes = (counted.match(/\}/g) ?? []).length
    depth += opens - closes
    if (sourceBlockDepth !== null && depth <= sourceBlockDepth) {
      sourceBlockDepth = null
    }
  })

  return violations
}

function checkTree(root: string): { files: string[]; violations: Violation[] } {
  const files = findTerraformFiles(root)
  const violations = files.flatMap((f) => checkTerraformFile(root, f))
  return { files, violations }
}

describe('no create-path resource references a plan-time-generated artefact (#1459)', () => {
  it('walks the whole repo, including both skeletons and every module tree', () => {
    const { files } = checkTree(repoRoot)

    const under = (prefix: string): number =>
      files.filter((f) => relative(repoRoot, f).startsWith(prefix)).length

    console.log(`terraform files scanned: ${files.length}`)

    // Enumeration, printed and asserted per prefix — not just a total count —
    // so a walk that silently stopped descending into one tree (the same
    // failure shape #1459 names for a hand-maintained list: a check that
    // skips an input it cannot evaluate shrinks its own scope and reports
    // the remainder as the whole) shows up here rather than being absorbed
    // into a still-plausible-looking total.
    expect(
      files.length,
      'found 0 .tf files — this is a broken walk, not a clean repo',
    ).toBeGreaterThan(0)
    expect(under('modules/'), 'did not reach the template-owned modules/ tree').toBeGreaterThan(0)
    expect(under('infra/'), 'did not reach infra/environments or infra/global').toBeGreaterThan(0)
    expect(
      under('_skeletons/sibling-template/'),
      'did not reach the sibling skeleton — it carries its own full copy of modules/cloud/aws/compute',
    ).toBeGreaterThan(0)
    expect(
      under('_skeletons/plugin-template/'),
      'did not reach the plugin skeleton',
    ).toBeGreaterThan(0)
    expect(
      under('services/_plugins/'),
      'did not reach the installed first-party plugins’ own terraform/',
    ).toBeGreaterThan(0)
  })

  it('finds zero violations across the real repo as it stands today', () => {
    const { files, violations } = checkTree(repoRoot)

    if (violations.length > 0) {
      console.error(
        violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.message}`).join('\n'),
      )
    }

    console.log(`terraform files scanned: ${files.length}, violations: ${violations.length}`)
    expect(violations).toEqual([])
  })
})

describe('fail-first proof: the guard actually fires on the #1457 shape', () => {
  /**
   * Reproduces the EXACT pre-#1460 shape of modules/cloud/aws/compute/main.tf
   * (see `git show d2b0fbbd~1:modules/cloud/aws/compute/main.tf`): a
   * `data "archive_file"` generating a zip at `${path.module}/placeholder.zip`,
   * consumed by `aws_lambda_function.filename` /
   * `source_code_hash` via `data.archive_file.placeholder.output_path` /
   * `.output_base64sha256`. No zip is written to the fixture — a fresh git
   * checkout of source alone never has one, which is the actual failure
   * condition on a first-time apply runner.
   */
  function writeBrokenFixture(dir: string): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'main.tf'),
      `terraform {
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
  }
}

data "archive_file" "placeholder" {
  type        = "zip"
  output_path = "\${path.module}/placeholder.zip"
  source {
    content  = "def handler(event, context):\\n    pass\\n"
    filename = "handler.py"
  }
}

resource "aws_lambda_function" "main" {
  function_name = "x"
  role          = "arn:aws:iam::123456789012:role/x"
  handler       = "x"
  runtime       = "python3.13"

  filename         = data.archive_file.placeholder.output_path
  source_code_hash = data.archive_file.placeholder.output_base64sha256
}
`,
    )
  }

  /** The actual #1460 fix: the bytes are committed, referenced directly. */
  function writeFixedFixture(dir: string): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'placeholder.zip'), Buffer.from('PK\x03\x04placeholder'))
    writeFileSync(
      join(dir, 'main.tf'),
      `terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

resource "aws_lambda_function" "main" {
  function_name = "x"
  role          = "arn:aws:iam::123456789012:role/x"
  handler       = "x"
  runtime       = "python3.13"

  filename         = "\${path.module}/placeholder.zip"
  source_code_hash = filebase64sha256("\${path.module}/placeholder.zip")

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}
`,
    )
  }

  function gitInitAndCommit(dir: string): void {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Biffo Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Biffo Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    }
    execFileSync('git', ['init', '-b', 'dev'], { cwd: dir, env })
    execFileSync('git', ['add', '.'], { cwd: dir, env })
    execFileSync('git', ['commit', '-m', 'chore: fixture'], { cwd: dir, env })
  }

  it('FAILS on the broken shape: an archive_file cross-reference with no committed zip', () => {
    const dir = makeTmpDir('biffo-tf-artifact-fail-first')
    writeBrokenFixture(dir)
    gitInitAndCommit(dir)

    const { violations } = checkTree(dir)

    console.log(`fixture violations: ${violations.length}`)
    // Exactly the two cross-references (filename + source_code_hash), not
    // three. A first version of this checker also flagged the fixture's
    // `source { filename = "handler.py" }` line as an "uncommitted file" —
    // that `filename` names a zip ENTRY, not a filesystem path, and is a
    // real false positive a looser assertion here would have let back in
    // silently. Regression-tested directly below as well.
    expect(violations).toHaveLength(2)
    expect(violations.every((v) => v.rule === 'archive-file-cross-reference')).toBe(true)
    expect(violations.every((v) => v.message.includes('#1457'))).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  })

  it("does NOT flag an archive_file source{} block's own filename (a zip entry name, not a path)", () => {
    // Isolates the false-positive fix from the test above: an archive_file
    // with no OTHER resource consuming its output must be silent — the
    // `source { filename = "handler.py" }` line inside it is not a
    // filesystem reference at all.
    const dir = makeTmpDir('biffo-tf-artifact-source-block')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'main.tf'),
      `data "archive_file" "unused" {
  type        = "zip"
  output_path = "\${path.module}/unused.zip"
  source {
    content  = "placeholder"
    filename = "handler.py"
  }
}
`,
    )
    gitInitAndCommit(dir)

    const { violations } = checkTree(dir)

    console.log(`fixture violations: ${violations.length}`)
    expect(violations).toEqual([])

    rmSync(dir, { recursive: true, force: true })
  })

  it('PASSES on the fixed shape: the same fixture, restored to the committed-bytes form', () => {
    const dir = makeTmpDir('biffo-tf-artifact-fixed')
    writeFixedFixture(dir)
    gitInitAndCommit(dir)

    const { violations } = checkTree(dir)

    console.log(`fixture violations: ${violations.length}`)
    expect(violations).toEqual([])

    rmSync(dir, { recursive: true, force: true })
  })

  it('FAILS on an uncommitted literal reference with no archive_file involved at all', () => {
    // Covers the OTHER half of the rule independently: a direct
    // filebase64sha256() literal call is enough to trip the guard even with
    // no data "archive_file" in sight, so a future module that generates its
    // artefact some other way (a local-exec provisioner, a checked-out build
    // step, …) is still caught.
    const dir = makeTmpDir('biffo-tf-artifact-uncommitted-literal')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'main.tf'),
      `resource "aws_lambda_function" "main" {
  function_name = "x"
  role          = "arn:aws:iam::123456789012:role/x"
  handler       = "x"
  runtime       = "python3.13"

  filename         = "\${path.module}/generated-not-committed.zip"
  source_code_hash = filebase64sha256("\${path.module}/generated-not-committed.zip")
}
`,
    )
    gitInitAndCommit(dir)

    const { violations } = checkTree(dir)

    console.log(`fixture violations: ${violations.length}`)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.every((v) => v.rule === 'uncommitted-file-reference')).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  })
})
