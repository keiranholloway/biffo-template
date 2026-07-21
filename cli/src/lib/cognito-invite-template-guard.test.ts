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
    expect(checkInviteTemplateSource('trap.tf', trap)).toHaveLength(1)
    expect(checkInviteTemplateSource('trap.tf', trap)[0].message).toContain('sms_message')
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
})
