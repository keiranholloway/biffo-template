/**
 * Content guard for Cognito `invite_message_template` blocks (issue #356).
 *
 * PR #353 (#350) added an `invite_message_template` to the auth module with
 * `email_subject` and `email_message` but no `sms_message`. Cognito's
 * CreateUserPool validates ALL THREE members of `adminCreateUserConfig
 * .inviteMessageTemplate` regardless of the invite channel, and rejects an empty
 * `sMSMessage` with:
 *
 *   InvalidParameterException: Value '' at
 *   'adminCreateUserConfig.inviteMessageTemplate.sMSMessage' failed to satisfy
 *   constraint: Member must have length greater than or equal to 6
 *
 * So the pool cannot be created at all and every fresh deploy fails on the very
 * first apply. Terraform is happy — `terraform validate` does not model Cognito's
 * API constraints — which is precisely why this must be a CONTENT check and not a
 * `validate`-only one. This guard asserts that any `invite_message_template`
 * block in the template-owned `modules/` tree assigns all three of
 * `email_subject`, `email_message`, and `sms_message`.
 *
 * NOTE ON CORRECTNESS OF THE GUARD ITSELF: a previous guard in this repo passed
 * because it matched its own explanatory comment rather than the code it checked.
 * This one strips HCL comments and heredoc bodies before scanning, so the prose
 * above (which names all three members) cannot satisfy the assertion, and its
 * tests assert it *fails* on a known-bad fixture and on a member that appears
 * only inside a comment — a guard that can only pass proves nothing.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The three members Cognito's CreateUserPool requires on every
 * `inviteMessageTemplate`. Omitting any one fails the API call (issue #356).
 */
export const REQUIRED_INVITE_MEMBERS = ['email_subject', 'email_message', 'sms_message'] as const

export interface Violation {
  file: string
  line: number
  message: string
}

/**
 * Replaces every heredoc body with a plain quoted placeholder so its content —
 * HTML, `#` characters, `{…}` braces, or even the literal text `sms_message =` —
 * cannot be mistaken for a comment, a member assignment, or a block boundary.
 * The `email_message = <<-EOT` assignment line itself is preserved.
 */
export function stripHeredocs(source: string): string {
  return source.replace(/<<-?(\w+)\r?\n[\s\S]*?\r?\n[ \t]*\1\b/g, '"HEREDOC"')
}

/**
 * Removes HCL comments — `/* … *\/` blocks and `#` / `//` line comments — so
 * prose describing a member cannot be mistaken for its assignment. Only `#`/`//`
 * at line start or preceded by whitespace starts a comment, matching HCL.
 */
export function stripHclComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)(#|\/\/).*$/, '$1'))
    .join('\n')
}

export interface Block {
  /** 1-based line where the block opens, for violation reporting. */
  line: number
  /** The text between the block's outermost braces. */
  body: string
}

/**
 * Extracts each `<name> { … }` block by brace matching, returning its body and
 * opening line. Assumes comments and heredocs have already been stripped;
 * balanced `{…}` placeholders inside quoted strings (`{username}`, `{####}`,
 * `${var.x}`) net to zero depth and so do not disturb the match.
 */
export function extractBlocks(source: string, name: string): Block[] {
  const blocks: Block[] = []
  const opener = new RegExp(`(?:^|[\\s])${name}\\s*\\{`, 'g')
  let match: RegExpExecArray | null
  while ((match = opener.exec(source)) !== null) {
    const openBrace = source.indexOf('{', match.index)
    let depth = 1
    let i = openBrace + 1
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') depth--
    }
    blocks.push({
      line: source.slice(0, match.index).split('\n').length,
      body: source.slice(openBrace + 1, i - 1),
    })
  }
  return blocks
}

/** Scans one Terraform file's source for invite blocks missing a member. */
export function checkInviteTemplateSource(file: string, rawSource: string): Violation[] {
  const source = stripHclComments(stripHeredocs(rawSource))
  const violations: Violation[] = []

  for (const block of extractBlocks(source, 'invite_message_template')) {
    for (const member of REQUIRED_INVITE_MEMBERS) {
      const assigned = new RegExp(`(?:^|[\\s{])${member}\\s*=`).test(block.body)
      if (!assigned) {
        violations.push({
          file,
          line: block.line,
          message:
            `invite_message_template is missing "${member}". Cognito's CreateUserPool ` +
            `validates all of ${REQUIRED_INVITE_MEMBERS.join(', ')} and rejects an empty ` +
            `member with InvalidParameterException ("length greater than or equal to 6"), ` +
            `so no user pool can be created and every fresh deploy fails (issue #356).`,
        })
      }
    }
  }

  return violations
}

/**
 * Collects `.tf` files under the template-owned `modules/` tree only. Scoping to
 * `modules/` keeps this template-owned guard from asserting over any path an
 * instance owns but cannot receive via `core upgrade` (the #325/#327 rule).
 */
export function findModuleTerraformFiles(repoRoot: string): string[] {
  const found: string[] = []

  const walk = (dir: string, relative: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === '.worktrees') continue
      const full = join(dir, entry)
      const rel = `${relative}/${entry}`
      if (statSync(full).isDirectory()) {
        walk(full, rel)
      } else if (entry.endsWith('.tf')) {
        found.push(rel)
      }
    }
  }

  walk(join(repoRoot, 'modules'), 'modules')
  return found.sort()
}

/** Checks every module Terraform file in the repo. Returns [] when the convention holds. */
export function checkCognitoInviteTemplates(repoRoot: string): Violation[] {
  return findModuleTerraformFiles(repoRoot).flatMap((file) =>
    checkInviteTemplateSource(file, readFileSync(join(repoRoot, file), 'utf8')),
  )
}
