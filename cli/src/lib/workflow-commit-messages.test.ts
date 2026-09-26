/**
 * Every `git commit` a workflow runs must survive the repo's real commit-msg
 * hook (#2115, remediation of #2125).
 *
 * ## Why
 *
 * `openrouter-snapshot-refresh.yml` runs `pnpm install`, whose `prepare` script
 * arms `.git/hooks/commit-msg` (commitlint) on the runner. Unlike `pre-push`,
 * that hook has no CI skip. The workflow's commit body was a single 110-column
 * line, commitlint's `footer-max-line-length`/`body-max-line-length` is 100, so
 * the scheduled refresh died at `git commit` every time it was due — no branch,
 * no PR, and the 45-day age gate fired on the calendar anyway. Nothing executed
 * the workflow's commit shell, so no test could see it.
 *
 * The class is "bot-authored commits in CI run under hooks armed by pnpm
 * install". This pins that seam: the messages are extracted from the real
 * workflow text (template's own workflows and every skeleton's) and committed
 * through the real `.githooks/commit-msg` in a scratch repo, so the message
 * that ships is the message that is judged. A `git commit` we cannot extract a
 * message from fails rather than passes — an empty extraction is not "fine".
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTmpDir } from '../test-utils/tmp.js'
import { isInstanceRepo } from './core-version.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export interface WorkflowCommit {
  file: string
  /** The `-m` paragraphs, in order, with shell substitutions replaced by `x`. */
  messages: string[]
}

/** Workflow files this repo ships: its own and every skeleton's. */
export function shippedWorkflowFiles(root: string): string[] {
  const dirs = [join(root, '.github/workflows')]
  const skeletons = join(root, '_skeletons')
  if (existsSync(skeletons)) {
    for (const s of readdirSync(skeletons)) dirs.push(join(skeletons, s, '.github/workflows'))
  }
  return dirs
    .filter((d) => existsSync(d))
    .flatMap((d) =>
      readdirSync(d)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => join(d, f)),
    )
}

/**
 * Each `git commit` invocation in `text` with its `-m "..."` / `-m '...'`
 * arguments. Backslash continuations are joined first; whole-line comments are
 * skipped; `git commit-tree` is not a commit. A commit with no extractable `-m`
 * yields an empty `messages` list, which callers must treat as a failure.
 */
export function extractGitCommits(file: string, text: string): WorkflowCommit[] {
  const joined = text.replace(/\\\r?\n\s*/g, ' ')
  const out: WorkflowCommit[] = []
  for (const line of joined.split('\n')) {
    if (/^\s*#/.test(line) || !/\bgit commit(?![\w-])/.test(line)) continue
    const messages = [...line.matchAll(/\s-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g)].map((m) =>
      (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}|\$\([^)]*\)|\$\w+/g, 'x'),
    )
    out.push({ file, messages })
  }
  return out
}

// Template-only: an instance has no _skeletons/ and its workflows are the
// template's, already checked here.
describe.skipIf(isInstanceRepo(repoRoot))(
  'workflow git commits under the armed commit-msg hook',
  () => {
    /** Commit `messages` in a scratch repo wired to this repo's real commit-msg hook. */
    function commitUnderArmedHook(messages: string[]): { code: number; output: string } {
      const dir = makeTmpDir('biffo-wf-commit')
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
      git('init', '-q', '-b', 'dev')
      git('config', 'user.email', 'bot@example.com')
      git('config', 'user.name', 'biffo-fleet[bot]')
      // What `pnpm install`'s prepare script does on the runner: point git at the hooks.
      git('config', 'core.hooksPath', join(repoRoot, '.githooks'))
      writeFileSync(join(dir, 'package.json'), '{}\n')
      writeFileSync(
        join(dir, 'commitlint.config.js'),
        readFileSync(join(repoRoot, 'commitlint.config.js')),
      )
      symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'))
      try {
        execFileSync('git', ['commit', '--allow-empty', ...messages.flatMap((m) => ['-m', m])], {
          cwd: dir,
          stdio: 'pipe',
        })
        return { code: 0, output: '' }
      } catch (err) {
        const e = err as { status?: number; stderr?: Buffer; stdout?: Buffer }
        return { code: e.status ?? 1, output: `${String(e.stderr ?? '')}${String(e.stdout ?? '')}` }
      }
    }

    const commits = shippedWorkflowFiles(repoRoot).flatMap((f) =>
      extractGitCommits(f, readFileSync(f, 'utf8')),
    )

    it('finds the commits the workflows actually make (guards against an empty denominator)', () => {
      const files = commits.map((c) => c.file.replace(`${repoRoot}/`, ''))
      expect(files).toContain('.github/workflows/openrouter-snapshot-refresh.yml')
      expect(files).toContain('_skeletons/plugin-template/.github/workflows/publish-registry.yml')
    })

    for (const c of commits) {
      it(`${c.file.replace(`${repoRoot}/`, '')}: message has a parsable -m and passes commitlint`, () => {
        expect(c.messages.length, 'git commit with no extractable -m message').toBeGreaterThan(0)
        const r = commitUnderArmedHook(c.messages)
        expect(r.output).toBe('')
        expect(r.code).toBe(0)
      })
    }

    it('the harness goes red on the original defect (110-column body line)', () => {
      const r = commitUnderArmedHook([
        'chore(cli): refresh OpenRouter model snapshot',
        'Scheduled by openrouter-snapshot-refresh.yml so the 45-day age gate never fires on the calendar alone (#2115).',
      ])
      expect(r.code).not.toBe(0)
      expect(r.output).toContain('must not be longer than 100 characters')
    })

    it('extractor joins continuations and skips comments and commit-tree', () => {
      const text = [
        '  # git commit -m "comment"',
        '  git commit-tree x -m "tree"',
        '  git commit -m "a: ${v}" \\',
        "    -m 'second'",
      ].join('\n')
      expect(extractGitCommits('f', text)).toEqual([{ file: 'f', messages: ['a: x', 'second'] }])
    })
  },
)
