import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  auditClaimInvocationParity,
  claimBlock,
  claimInvocations,
  distributedAgentsDocs,
  formatParityViolations,
} from './claim-invocation-parity.js'
import { makeTmpDir } from '../test-utils/tmp.js'

/**
 * The three `AGENTS.md` copies must agree on how you claim an issue (#1562).
 *
 * See `claim-invocation-parity.ts` for why this exists. In short: `--as`
 * shipped to one of three copies, the other two are what every satellite
 * receives, and so the flag was documented in **zero** satellites while the
 * feature itself worked perfectly.
 */

/** The repo root — the directory holding `shared-files.json`. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'shared-files.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Resolution failing must FAIL the test, not silence it: a walk that
  // overshoots finds no AGENTS.md, and an empty input set passes against
  // anything — the defect `skeleton-drift-guard.test.ts` had once.
  throw new Error(`could not locate shared-files.json above ${fileURLToPath(import.meta.url)}`)
}

const CANONICAL = [
  '```bash',
  'sh scripts/biffo.sh claim <issue-number> --as <token> [-R owner/repo]  # 0 free · 1 taken · 2 cannot tell',
  'sh scripts/biffo.sh claim <issue-number> --release <token>             # only the holder may clear it',
  '```',
].join('\n')

function fixture(files: Record<string, string>): string {
  const root = makeTmpDir('claim-parity')
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
  return root
}

describe('extraction', () => {
  it('reads the claim invocations out of a fenced block', () => {
    expect(claimBlock(`intro\n\n${CANONICAL}\n\ntail\n`)).toEqual([
      'sh scripts/biffo.sh claim <issue-number> --as <token> [-R owner/repo]  # 0 free · 1 taken · 2 cannot tell',
      'sh scripts/biffo.sh claim <issue-number> --release <token>             # only the holder may clear it',
    ])
  })

  it('ignores prose that merely mentions claiming', () => {
    expect(claimBlock('Release what you claim when the PR merges.\n')).toEqual([])
    expect(claimInvocations('A claim you never release is worse than no claim.\n')).toEqual([])
  })

  it('finds an invocation hidden in an inline code span, not just in a fence', () => {
    // Prose is where a bare form comes back after the fenced block is fixed.
    expect(claimInvocations('Release it with `claim <issue-number> --release <token>`.\n')).toEqual(
      ['claim <issue-number> --release <token>'],
    )
  })
})

describe('parity audit', () => {
  const good = `# rules\n\n${CANONICAL}\n`

  it('passes when every copy carries the identical block', () => {
    const root = fixture({
      'AGENTS.md': good,
      '_skeletons/sibling-template/AGENTS.md': good,
      '_skeletons/plugin-template/AGENTS.md': good,
    })
    expect(auditClaimInvocationParity(distributedAgentsDocs(root))).toEqual([])
  })

  it('fails when a skeleton drops the token — the exact #1562 drift', () => {
    const root = fixture({
      'AGENTS.md': good,
      '_skeletons/sibling-template/AGENTS.md': good,
      '_skeletons/plugin-template/AGENTS.md':
        '# rules\n\n```bash\nsh scripts/biffo.sh claim <issue-number> [-R owner/repo]\n```\n',
    })
    const v = auditClaimInvocationParity(distributedAgentsDocs(root))
    expect(v.map((x) => x.rule)).toContain('block-drift')
    expect(v.map((x) => x.rule)).toContain('untokened-form')
    expect(formatParityViolations(v)).toContain('_skeletons/plugin-template/AGENTS.md')
  })

  it('fails on a bare form reintroduced in prose, with the fenced block still correct', () => {
    const root = fixture({
      'AGENTS.md': `${good}\nQuick check: \`sh scripts/biffo.sh claim <issue-number>\`.\n`,
      '_skeletons/sibling-template/AGENTS.md': good,
    })
    const v = auditClaimInvocationParity(distributedAgentsDocs(root))
    expect(v.filter((x) => x.rule === 'untokened-form')).toHaveLength(1)
    expect(v.filter((x) => x.rule === 'block-drift')).toHaveLength(0)
  })

  it('fails a copy that documents claiming but never releasing', () => {
    const onlyClaim =
      '# rules\n\n```bash\nsh scripts/biffo.sh claim <issue-number> --as <token>\n```\n'
    const root = fixture({ 'AGENTS.md': onlyClaim })
    const v = auditClaimInvocationParity(distributedAgentsDocs(root))
    expect(v.map((x) => x.detail).join('\n')).toMatch(/--release/)
  })

  it('an empty input set is a failure, not a pass', () => {
    // A guard that finds nothing to check reports success against the very bug
    // it exists to catch. #695, and skeleton-drift-guard's overshooting walk.
    expect(auditClaimInvocationParity([])).toHaveLength(1)
    expect(auditClaimInvocationParity([])[0]!.rule).toBe('no-copies')
  })

  it('discovers skeletons rather than being told them', () => {
    const root = fixture({
      'AGENTS.md': good,
      '_skeletons/sibling-template/AGENTS.md': good,
      '_skeletons/plugin-template/AGENTS.md': good,
      // A skeleton added tomorrow is covered the day it lands.
      '_skeletons/worker-template/AGENTS.md':
        '# rules\n\n```bash\nsh scripts/biffo.sh claim <issue-number>\n```\n',
      // Content, not a repo scaffold: no AGENTS.md, contributes nothing.
      '_skeletons/registry/plugins.json': '{}',
    })
    const docs = distributedAgentsDocs(root)
    expect(docs.map((d) => d.path)).toEqual([
      'AGENTS.md',
      '_skeletons/plugin-template/AGENTS.md',
      '_skeletons/sibling-template/AGENTS.md',
      '_skeletons/worker-template/AGENTS.md',
    ])
    expect(auditClaimInvocationParity(docs).some((v) => v.path.includes('worker-template'))).toBe(
      true,
    )
  })
})

describe('the real distributed copies', () => {
  const docs = distributedAgentsDocs(repoRoot())

  it('finds all three copies — the sweep has something to sweep', () => {
    expect(docs.map((d) => d.path)).toEqual([
      'AGENTS.md',
      '_skeletons/plugin-template/AGENTS.md',
      '_skeletons/sibling-template/AGENTS.md',
    ])
  })

  it('agree on the documented claim invocation', () => {
    const v = auditClaimInvocationParity(docs)
    expect(formatParityViolations(v)).toBe('')
  })

  it('document the mandatory form the script actually enforces', () => {
    for (const doc of docs) {
      expect(claimBlock(doc.text), doc.path).toEqual([
        'sh scripts/biffo.sh claim <issue-number> --as <token> [-R owner/repo]  # 0 free · 1 taken · 2 cannot tell',
        'sh scripts/biffo.sh claim <issue-number> --release <token>             # only the holder may clear it',
      ])
    }
  })
})
