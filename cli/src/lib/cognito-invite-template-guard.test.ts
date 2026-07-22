import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkCognitoInviteTemplates,
  checkInviteTemplateSource,
  extractBlocks,
  findModuleTerraformFiles,
  REQUIRED_INVITE_MEMBERS,
  stripHclComments,
  stripHeredocs,
} from './cognito-invite-template-guard.js'

const repoRoot = join(__dirname, '..', '..', '..')

/** The exact shape of the bug in #356: an invite block with no sms_message. */
const BROKEN = `
resource "aws_cognito_user_pool" "main" {
  admin_create_user_config {
    invite_message_template {
      email_subject = "Your admin account"
      email_message = "Username {username}, password {####}."
    }
  }
}
`

/** The fix: all three members present, each carrying the placeholders. */
const FIXED = `
resource "aws_cognito_user_pool" "main" {
  admin_create_user_config {
    invite_message_template {
      email_subject = "Your admin account"
      email_message = <<-EOT
        Username {username}, temporary password {####}.
      EOT
      sms_message = "Your admin username is {username}, temporary password {####}."
    }
  }
}
`

describe('stripHeredocs', () => {
  it('replaces a heredoc body, keeping the assignment', () => {
    const stripped = stripHeredocs(FIXED)
    expect(stripped).toContain('email_message = "HEREDOC"')
    // Content inside the heredoc must not survive to be scanned as HCL.
    expect(stripped).not.toContain('temporary password {####}.\n      EOT')
  })

  it('neutralises a member name that appears only inside a heredoc body', () => {
    const trap = `
      invite_message_template {
        email_subject = "s"
        email_message = <<-EOT
          this prose says sms_message = "x" but it is not real HCL
        EOT
      }
    `
    // The heredoc mentions sms_message, but it is body text, not an assignment.
    // Asserted by content rather than by total count: this fixture's heredoc also
    // lacks the required {username}/{####} placeholders, which is a separate and
    // equally real violation. What matters here is that the *missing member* is
    // still reported despite the decoy text.
    const missingMember = checkInviteTemplateSource('trap.tf', trap).filter((v) =>
      v.message.includes('is missing "sms_message"'),
    )
    expect(missingMember).toHaveLength(1)
  })
})

describe('stripHclComments', () => {
  it('removes #, // and block comments', () => {
    expect(stripHclComments('  # sms_message = "x"\n')).not.toContain('sms_message')
    expect(stripHclComments('foo() // sms_message = "x"\n')).not.toContain('sms_message')
    expect(stripHclComments('/* sms_message = "x" */')).not.toContain('sms_message')
  })

  it('keeps a # that is part of a value, not a comment', () => {
    expect(stripHclComments('password {####}')).toContain('{####}')
  })
})

describe('extractBlocks', () => {
  it('matches braces through balanced {…} placeholders in strings', () => {
    const blocks = extractBlocks(stripHclComments(stripHeredocs(FIXED)), 'invite_message_template')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].body).toContain('sms_message =')
    // The block must end at its own brace, not swallow the rest of the file.
    expect(blocks[0].body).not.toContain('resource "aws_cognito_user_pool"')
  })
})

describe('checkInviteTemplateSource', () => {
  it('FAILS on the real #356 regression (missing sms_message)', () => {
    const violations = checkInviteTemplateSource('bad.tf', BROKEN)
    expect(violations).toHaveLength(1)
    expect(violations[0].message).toContain('sms_message')
  })

  it('passes once all three members are present', () => {
    expect(checkInviteTemplateSource('good.tf', FIXED)).toEqual([])
  })

  it('does not accept a member that appears only in a comment', () => {
    // The trap a previous guard in this repo fell into: matching its own prose.
    const commentOnly = BROKEN.replace(
      'email_message = "Username {username}, password {####}."',
      'email_message = "Username {username}, password {####}."\n      # sms_message = "{username} {####}"',
    )
    expect(checkInviteTemplateSource('trap.tf', commentOnly)).toHaveLength(1)
    expect(checkInviteTemplateSource('trap.tf', commentOnly)[0].message).toContain('sms_message')
  })

  it('flags each missing member independently', () => {
    for (const member of REQUIRED_INVITE_MEMBERS) {
      const lines = [
        'invite_message_template {',
        ...REQUIRED_INVITE_MEMBERS.filter((m) => m !== member).map(
          (m) => `  ${m} = "x {username} {####}"`,
        ),
        '}',
      ]
      const violations = checkInviteTemplateSource(`${member}.tf`, lines.join('\n'))
      expect(violations).toHaveLength(1)
      expect(violations[0].message).toContain(member)
    }
  })

  it('ignores files with no invite_message_template block', () => {
    expect(checkInviteTemplateSource('none.tf', 'resource "x" "y" {}\n')).toEqual([])
  })
})

describe('findModuleTerraformFiles', () => {
  it('finds the auth module and stays inside modules/', () => {
    const files = findModuleTerraformFiles(repoRoot)
    expect(files).toContain('modules/cloud/aws/auth/main.tf')
    expect(files.every((f) => f.startsWith('modules/'))).toBe(true)
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true)
  })
})

describe('the repository itself', () => {
  it('has no Cognito invite template missing a required member (#356)', () => {
    expect(checkCognitoInviteTemplates(repoRoot)).toEqual([])
  })

  it('requires {username} and {####} in both message bodies', () => {
    // Verified against the live CreateUserPool API: a template without these is
    // rejected outright, so a missing placeholder is a failed deploy, not a
    // cosmetic problem. {username} is required even when the pool uses
    // username_attributes and the value is an opaque UUID.
    const missing = `
      invite_message_template {
        email_subject = "s"
        email_message = <<-EOT
          Sign in with your email address. Temporary password: {####}
        EOT
        sms_message = "Temporary password {####}"
      }
    `
    const violations = checkInviteTemplateSource('a.tf', missing)
    expect(violations.filter((v) => v.message.includes('{username}'))).toHaveLength(2)
  })

  it('accepts a template that keeps the placeholders', () => {
    const ok = `
      invite_message_template {
        email_subject = "s"
        email_message = <<-EOT
          Sign in with the email address this was sent to.<br>
          Temporary password: <b><code>{####}</code></b><br>
          Account reference: {username} — for support only.
        EOT
        sms_message = "Temporary password {####}. Sign in with your email. (Ref {username})"
      }
    `
    expect(checkInviteTemplateSource('a.tf', ok)).toEqual([])
  })

  it('does not mistake hex colours in a branded HTML body for comments', () => {
    // Regression: the placeholder check originally ran over comment-stripped
    // source. A branded invite is full of `color:#0f1613`, and outside a
    // heredoc `#` starts a comment — so the stripper deleted the rest of those
    // lines and took {####} with them, failing a template that was correct.
    const branded = `
      invite_message_template {
        email_subject = "s"
        email_message = <<-EOT
          <div style="color:#0f1613">
            <h2 style="color:#006c49">Welcome</h2>
            <p style="background:#f0f4f2">{####}</p>
            <p style="color:#8a9691">Ref {username}</p>
          </div>
        EOT
        sms_message = "Password {####} (Ref {username})"
      }
    `
    expect(checkInviteTemplateSource('branded.tf', branded)).toEqual([])
  })
})
