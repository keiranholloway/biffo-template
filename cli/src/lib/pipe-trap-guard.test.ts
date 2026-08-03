import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findPipeTraps } from './pipe-trap-guard.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * The detector is exercised against known-bad and known-good input BEFORE it is
 * pointed at the real scripts.
 *
 * A guard that has never been seen to fail is not evidence of anything — #1231
 * says so explicitly, and `fail-first-experiment-discipline` records the cost of
 * skipping it. The known-bad cases below are the exact lines from this estate's
 * own history, not invented ones.
 */
describe('the detector catches the real failures', () => {
  it('flags the line that reported exit 0 for every issue checked', () => {
    // Hit twice in one session by the author of the rule (#1231).
    const traps = findPipeTraps('sh scripts/claim.sh 1058 | tail -3 ; echo "exit: $?"\n')
    expect(traps).toHaveLength(1)
    expect(traps[0]?.reason).toContain('status-bearing command upstream of a pipe')
  })

  it('flags a piped git push, which is how commits get lost', () => {
    // A rejected push reads as success, and the commits get squash-merged
    // missing (AGENTS.md §4).
    expect(findPipeTraps('git push -u origin HEAD | tail -2\n')).toHaveLength(1)
  })

  it('flags $? read on the line after a pipeline', () => {
    // The two-line form, which is what actually shipped.
    const traps = findPipeTraps('sh scripts/wait-for-checks.sh 12 | tail -1\necho "rc: $?"\n')
    expect(traps.length).toBeGreaterThanOrEqual(1)
    expect(traps.some((t) => t.reason.includes('$? read directly after a pipeline'))).toBe(true)
  })
})

describe('the detector does not fire on its own subject matter', () => {
  it('ignores the pattern inside a comment', () => {
    // This is the failure mode a grep-based guard has: the guard, the rule in
    // AGENTS.md, and this very test all NAME the bad pattern.
    expect(
      findPipeTraps('# never write: git push | tail -3 ; echo $?\ngit push origin HEAD\n'),
    ).toEqual([])
  })

  it('ignores the pattern inside a quoted string', () => {
    expect(findPipeTraps('echo "do not do: sh scripts/claim.sh 1 | tail"\n')).toEqual([])
  })

  it('does not mistake || for a pipe', () => {
    expect(findPipeTraps('git push origin HEAD || exit 1\n')).toEqual([])
  })

  it('allows a pipe whose head carries no meaningful status', () => {
    // `grep`, `sed` and friends are not status-bearing here; piping them is
    // ordinary shell, and flagging it would make the guard noise.
    expect(findPipeTraps('grep -n foo bar.txt | head -3\n')).toEqual([])
  })

  it('allows a query flag, where the OUTPUT is the answer', () => {
    // `verify.sh --list` prints check names; its exit code carries nothing, so
    // piping it discards nothing. Both live uses in this repo are this shape,
    // and the guard flagged them on its first run — a real finding about the
    // DETECTOR, caught by pointing it at the estate before trusting it.
    expect(
      findPipeTraps('for p in $( (cd "$d" && sh scripts/verify.sh --list) | grep -oE "x"); do\n'),
    ).toEqual([])
  })

  it('still flags the same command without a query flag', () => {
    // The exemption is the FLAG, not the script — otherwise it would be a hole.
    expect(findPipeTraps('sh scripts/verify.sh | tail -1\n')).toHaveLength(1)
  })

  it('does not flag $? after an ordinary command', () => {
    expect(findPipeTraps('git push origin HEAD\necho "exit: $?"\n')).toEqual([])
  })
})

/**
 * The sweep. Scoped to the shell this estate actually runs: the scripts that
 * ship inside the published package, plus the hooks every repo executes.
 *
 * Since #1109 there is ONE copy of each of these, so a clean sweep here is a
 * statement about all 14 satellites rather than about this repo alone — which
 * is what makes the guard worth having now and not before.
 */
function shellFiles(): string[] {
  const out: string[] = []
  for (const dir of ['scripts', '.githooks']) {
    const full = join(repoRoot, dir)
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (dir === 'scripts' && !entry.name.endsWith('.sh')) continue
      out.push(join(full, entry.name))
    }
  }
  return out
}

describe('the estate’s own shell is clean', () => {
  it('has no pipe traps in any packaged script or hook', () => {
    const findings = shellFiles().flatMap((file) =>
      findPipeTraps(readFileSync(file, 'utf8')).map(
        (t) => `${relative(repoRoot, file)}:${t.line}  ${t.text}\n    ${t.reason}`,
      ),
    )
    expect(findings, `\n${findings.join('\n')}\n`).toEqual([])
  })

  it('checks a non-trivial number of files, or it is asserting nothing', () => {
    // A sweep that silently matched zero files would pass forever. This estate
    // has found that shape repeatedly — an audit whose map was empty reported
    // clean across every repo.
    expect(shellFiles().length).toBeGreaterThan(15)
  })
})
