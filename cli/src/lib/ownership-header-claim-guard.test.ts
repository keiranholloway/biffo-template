import { describe, expect, it } from 'vitest'
import type { CoreManifest } from './core-manifest.js'
import {
  checkOwnershipHeaderClaims,
  findHeaderClaim,
  type HeaderClaimHit,
} from './ownership-header-claim-guard.js'

// `cli/` is deliberately modelled as `released`, NOT `templateOwned` — that
// is the real shape of the repo's own `core-manifest.json` (`isTemplateOwned`
// returns `false` for a `released`-only path; see `core-manifest.ts`'s
// `CoreManifestSchema` doc comment), and it is exactly the shape #1937 found
// this fixture failing to reproduce: with `cli/` in `templateOwned` instead,
// `matchesReleased` was never exercised by any test here at all.
const MANIFEST: CoreManifest = {
  version: 1,
  templateOwned: ['services/api/', 'services/_plugins/', 'scripts/', 'infra/'],
  userOwned: ['services/api/src/api/domains/', 'scripts/verify-deployed.checks'],
  released: ['cli/'],
}

describe('findHeaderClaim — real corpus fixtures', () => {
  // Captured verbatim from `scripts/verify-deployed.checks` line 1, the
  // exact instance #1706/#1707 fixed by hand.
  it('reads the all-caps INSTANCE-OWNED convention (scripts/verify-deployed.checks)', () => {
    const content =
      '# Checks for `verify-deployed.sh`. INSTANCE-OWNED — the mechanism is the same across\n' +
      '# the estate, the checks are not. This file is seeded, never overwritten by a sync.\n' +
      '#\n' +
      '#   <name>  <persona-id>  <method>  <path>  <expect>\n'
    const hit = findHeaderClaim('scripts/verify-deployed.checks', content)
    expect(hit).toEqual<HeaderClaimHit>({
      path: 'scripts/verify-deployed.checks',
      claim: 'user',
      matchedPhrase: 'INSTANCE-OWNED',
      line: 1,
    })
  })

  // Captured verbatim from `services/api/src/api/domains/__init__.py`'s
  // module docstring: line 1 mentions "user-owned" in plain prose ("a
  // user-owned guest") with no self-referential copula, line 4 makes the
  // real self-claim ("This package (...) is **user-owned**"), and line 5
  // mentions "template-owned" describing the DIFFERENT surrounding
  // `services/api/` path. Only line 4's grammatically self-referential
  // phrase may register as a candidate — line 1's bare mention and line 5's
  // claim-about-a-different-path must not — so the guard is exercised
  // against all three in one fixture rather than three separate ones.
  it('finds the self-referential claim, not an earlier bare mention or a later claim about a different path (services/api/src/api/domains/__init__.py)', () => {
    const content =
      '"""Instance product-domain code — a user-owned guest hosted in the core API\n' +
      '(ADR-0022).\n' +
      '\n' +
      'This package (``services/api/src/api/domains/``) is **user-owned** in\n' +
      '``core-manifest.json`` even though it sits inside the template-owned\n' +
      '``services/api/`` (longest-prefix-wins, exactly as ``migrations/versions/`` is).\n' +
      '"""\n'
    const hit = findHeaderClaim('services/api/src/api/domains/__init__.py', content)
    expect(hit?.claim).toBe('user')
    expect(hit?.matchedPhrase.toLowerCase()).toBe('user-owned')
    expect(hit?.line).toBe(4)
  })

  // Captured verbatim from `services/_plugins/agent-runtime/terraform/main.tf`.
  it('reads a leading `#` comment block claim (agent-runtime terraform/main.tf)', () => {
    const content =
      '# Terraform for the agent runtime plugin (ADR-0014 §1, ADR-0003 section 2 layout).\n' +
      '#\n' +
      '# The agent framework is first-party platform capability, not a marketplace\n' +
      '# plugin: this directory is template-owned and reaches instances via\n' +
      '# `biffo core upgrade`.\n'
    const hit = findHeaderClaim('services/_plugins/agent-runtime/terraform/main.tf', content)
    expect(hit).toMatchObject({ claim: 'template', line: 4 })
  })

  // Captured verbatim from `infra/environments/dev/artifacts.core.tf` line 1.
  it('reads a one-line em-dash claim (infra/environments/dev/artifacts.core.tf)', () => {
    const content =
      '# Lambda deployment-artifacts bucket (#994) — template-owned, like\n' +
      '# plugins.core.tf / plugin-host.core.tf / pr-signer.core.tf.\n'
    const hit = findHeaderClaim('infra/environments/dev/artifacts.core.tf', content)
    expect(hit).toMatchObject({ claim: 'template', line: 1 })
  })

  // Captured verbatim from `services/_plugins/agent-runtime/biffo.plugin.json`'s
  // "description" field — JSON has no comment syntax, so this is handled as a
  // dedicated case rather than a "header" in the source-file sense.
  it('reads a JSON manifest "description" field claim (agent-runtime biffo.plugin.json)', () => {
    const content = JSON.stringify(
      {
        name: 'agent-runtime',
        version: '0.1.0',
        description:
          'The agentic-worker execution runtime (ADR-0014). Owns no data. First-party and ' +
          'template-owned: distributed by `biffo core upgrade`, not the plugin registry.',
      },
      null,
      2,
    )
    const hit = findHeaderClaim('services/_plugins/agent-runtime/biffo.plugin.json', content)
    expect(hit?.claim).toBe('template')
    expect(hit?.matchedPhrase.toLowerCase()).toBe('template-owned')
  })

  // Captured (trimmed) verbatim from `.github/workflows/ci.yml`'s real first
  // lines — no leading `#` comment at all, so there is no header to read a
  // claim from, even though the file mentions "template-owned" thousands of
  // lines later in unrelated prose about other paths. This is the case the
  // whole leading-header restriction exists for (see the module doc comment):
  // a bare substring sweep over the whole file would misfire on this file
  // constantly, since deploy-app.yml/ci.yml mention the phrase dozens of
  // times about paths that are not themselves.
  it('finds no claim when the file has no leading comment at all (ci.yml shape)', () => {
    const content = 'name: CI\n\non:\n  push:\n    branches: [main, dev, staging]\n'
    expect(findHeaderClaim('.github/workflows/ci.yml', content)).toBeNull()
  })

  // Captured verbatim from `cli/src/scripts/check-release-subject.ts`'s real
  // leading doc-comment: it mentions "template-owned" describing its
  // SUBJECT MATTER ("any [...] template-owned path" the guard inspects, not
  // itself), with no self-referential "this/it is" before the word and not
  // on line 1 with an em-dash. This is the same false-positive SHAPE as
  // `domain_requirements.py`/`identity/__init__.py` (see module doc comment
  // item 2), and the self-referential-grammar requirement correctly excludes
  // it here too: no claim at all, rather than a coincidental match.
  it('finds no claim in generic "template-owned" prose describing the guard\'s subject matter, not itself (cli/src/scripts/check-release-subject.ts)', () => {
    const content =
      '/**\n' +
      ' * CI guard (ADR-0006 versioning discipline): on a pull request that changes any\n' +
      ' * template-owned path, fail unless the **pull request title** parses as a\n' +
      ' * Conventional Commits subject.\n' +
      ' */\n' +
      "import { execa } from '../lib/exec.js'\n"
    const hit = findHeaderClaim('cli/src/scripts/check-release-subject.ts', content)
    expect(hit).toBeNull()
  })

  it('reads a TS header placed after imports (real convention: instance-adoption.ts style)', () => {
    const content =
      "import { existsSync, readFileSync } from 'node:fs'\n" +
      "import { join } from 'node:path'\n" +
      '\n' +
      '/**\n' +
      ' * Some module whose header explains it is template-owned tooling.\n' +
      ' */\n'
    const hit = findHeaderClaim('cli/src/lib/example.ts', content)
    expect(hit).toMatchObject({ claim: 'template', line: 5 })
  })

  it('reads a Python module docstring on the very first line', () => {
    const content = '"""One line. INSTANCE-OWNED — seeded, never synced."""\n'
    const hit = findHeaderClaim('services/api/tests/example.py', content)
    expect(hit).toMatchObject({ claim: 'user', line: 1 })
  })

  it('reads the "NOT a template file" phrasing', () => {
    const content = '#!/usr/bin/env sh\n# NOT a template file — instance-authored.\n'
    const hit = findHeaderClaim('scripts/example.sh', content)
    expect(hit).toMatchObject({ claim: 'user', line: 2 })
  })

  it('finds no claim in a header that never mentions ownership', () => {
    const content = '#!/usr/bin/env sh\n# Does something entirely unrelated.\n'
    expect(findHeaderClaim('scripts/unrelated.sh', content)).toBeNull()
  })

  // biffo-template#1959: reproduced from the exact docstring that tripped
  // this in tabsii-platform#1392 (`services/api/tests/instance/
  // test_boto3_absent_after_import_api_main.py`, a user-owned instance test
  // file — that file does not exist in biffo-template itself, but the
  // ambiguity is general and this fixture reproduces it directly). "it"
  // grammatically refers to the DIFFERENT, template-owned file named
  // earlier in the same sentence, not to this docstring's own (user-owned)
  // file — the pronoun analogue of the module doc comment's "named-path-
  // before-self" case (item 2), which SELF_REFERENTIAL_CLAIM's plain
  // "this/it is X" grammar could not previously tell apart from a genuine
  // self-claim.
  it('does not read a pronoun naming a DIFFERENT file earlier in the same sentence as a self-claim (#1959)', () => {
    const content =
      '"""``services/api/tests/test_api_boto3_lazy_import.py`` already does the\n' +
      'same subprocess/``sys.modules`` check, but it is template-owned — this\n' +
      'file additionally guards the Lambda entrypoint import for the instance.\n' +
      '"""\n'
    const hit = findHeaderClaim(
      'services/api/tests/instance/test_boto3_absent_after_import_api_main.py',
      content,
    )
    expect(hit).toBeNull()
  })

  // The fix must not overcorrect into "any other path mentioned anywhere in
  // the header suppresses every claim" — a path named in an EARLIER,
  // separate sentence/paragraph must not blind the guard to a genuine
  // self-claim made afterward. This is the real domains/__init__.py SHAPE
  // (a different path is discussed, then the file declares itself), just
  // via a pronoun rather than "This package" — proving the fix is scoped to
  // the pronoun's own sentence, not the whole header.
  it('still catches a genuine pronoun self-claim made in a later sentence than an unrelated path mention', () => {
    const content =
      '"""``services/api/legacy/old_check.py`` used to cover this, before the\n' +
      'domain split.\n' +
      '\n' +
      'It is user-owned and lives alongside the rest of the instance test suite.\n' +
      '"""\n'
    const hit = findHeaderClaim('services/api/tests/instance/example.py', content)
    expect(hit).toMatchObject({ claim: 'user' })
  })

  // biffo-template#1971: #1970's own sentence-boundary walk used `\.\s` to
  // find "the end of the previous sentence", which misreads an ellipsis (or
  // an abbreviation's period) as a real sentence break. That lets the
  // boundary land AFTER the other-path mention instead of before it, so the
  // bare pronoun's own paragraph/sentence scan never sees the antecedent —
  // reproducing the #1959 false-positive shape via punctuation instead of a
  // missing check. Reproduced verbatim from the issue against 5f93d4a1.
  it('does not read a bare pronoun as self-referential when an ellipsis sits between it and an earlier other-path mention (#1971)', () => {
    const content =
      '"""``other/path/here.py`` already covers cases like malformed input, empty\n' +
      'strings, etc... it is template-owned, unlike this file.\n"""\n'
    const hit = findHeaderClaim('services/api/tests/instance/adv.py', content)
    expect(hit).toBeNull()
  })

  // biffo-template#1972: #1970's sentenceNamesOtherPath suppressed ANY
  // grammatical match with another path named earlier in its sentence, even
  // when the matched pronoun already carries its own concrete, unambiguous
  // subject ("this module") rather than being a bare "this"/"it". A path
  // named earlier purely as a cross-reference must not blind the guard to a
  // genuine, unambiguous self-claim later in the same sentence.
  it('still catches a genuine self-claim through a qualified "this <noun>" even when another path is named earlier in the same sentence (#1972)', () => {
    const content =
      '"""See ``services/api/other_thing.py`` for details; this module is\n' +
      'user-owned and separate.\n"""\n'
    const hit = findHeaderClaim('services/api/tests/instance/example2.py', content)
    expect(hit).toMatchObject({ claim: 'user' })
  })
})

describe('checkOwnershipHeaderClaims — compares against the real manifest authority', () => {
  it('reports no disagreement when a header claim matches the manifest', () => {
    const hits: HeaderClaimHit[] = [
      {
        path: 'scripts/verify-deployed.checks',
        claim: 'user',
        matchedPhrase: 'INSTANCE-OWNED',
        line: 1,
      },
      {
        path: 'services/api/src/api/domains/__init__.py',
        claim: 'user',
        matchedPhrase: 'user-owned',
        line: 1,
      },
      {
        path: 'services/_plugins/agent-runtime/terraform/main.tf',
        claim: 'template',
        matchedPhrase: 'template-owned',
        line: 4,
      },
    ]
    expect(checkOwnershipHeaderClaims(hits, MANIFEST)).toEqual([])
  })

  // The fail-first evidence for #1911: a header claiming a status
  // `core-manifest.json` disagrees with must be reported — this is exactly
  // the #1706/#1707 shape (verify-deployed.checks' header said INSTANCE-OWNED
  // while the manifest, before that fix, said template-owned by default).
  it('reports a disagreement when a header claim contradicts the manifest (the #1706/#1707 shape, reproduced)', () => {
    const hits: HeaderClaimHit[] = [
      {
        path: 'scripts/verify-deployed.checks',
        claim: 'user',
        matchedPhrase: 'INSTANCE-OWNED',
        line: 1,
      },
    ]
    // A manifest with NO carve-out for verify-deployed.checks — the state
    // this repo was actually in before #1707 added the userOwned entry.
    const manifestBeforeFix: CoreManifest = {
      version: 1,
      templateOwned: ['scripts/'],
      userOwned: [],
    }
    const disagreements = checkOwnershipHeaderClaims(hits, manifestBeforeFix)
    expect(disagreements).toHaveLength(1)
    expect(disagreements[0]).toMatchObject({
      path: 'scripts/verify-deployed.checks',
      claim: 'user',
      manifestSaysTemplateOwned: true,
    })
  })

  it('reports a disagreement in the other direction too (header claims template-owned, manifest says user-owned)', () => {
    const hits: HeaderClaimHit[] = [
      {
        path: 'services/api/src/api/domains/__init__.py',
        claim: 'template',
        matchedPhrase: 'template-owned',
        line: 5,
      },
    ]
    const disagreements = checkOwnershipHeaderClaims(hits, MANIFEST)
    expect(disagreements).toHaveLength(1)
    expect(disagreements[0].manifestSaysTemplateOwned).toBe(false)
  })

  // The #1937 regression: `cli/` is `released`, not `templateOwned`, so
  // `isTemplateOwned('cli/src/...', MANIFEST)` is `false`. Before the fix,
  // `!manifestSaysTemplateOwned` alone made ANY `'user'` claim on a `cli/`
  // path agree unconditionally — a fabricated `INSTANCE-OWNED`/`user-owned`
  // self-claim on an ordinary released `cli/` file was never flagged. This
  // is the exact drift shape #1706/#1707 was about, just under `cli/`.
  it('flags a user-owned/INSTANCE-OWNED claim on a released path as a disagreement (the #1937 blind spot)', () => {
    const hits: HeaderClaimHit[] = [
      {
        path: 'cli/src/commands/deploy.ts',
        claim: 'user',
        matchedPhrase: 'INSTANCE-OWNED',
        line: 3,
      },
    ]
    const disagreements = checkOwnershipHeaderClaims(hits, MANIFEST)
    expect(disagreements).toHaveLength(1)
    expect(disagreements[0]).toMatchObject({
      path: 'cli/src/commands/deploy.ts',
      claim: 'user',
      manifestSaysTemplateOwned: false,
    })
  })

  // The carve-out's other, already-correct half, reasserted against the
  // properly-shaped `released` fixture (not `templateOwned`) so it is
  // actually exercising `matchesReleased` rather than `isTemplateOwned`.
  it('does not flag a template-owned claim on a released path (the intended carve-out)', () => {
    const hits: HeaderClaimHit[] = [
      {
        path: 'cli/src/lib/example.ts',
        claim: 'template',
        matchedPhrase: 'template-owned',
        line: 5,
      },
    ]
    expect(checkOwnershipHeaderClaims(hits, MANIFEST)).toEqual([])
  })
})
