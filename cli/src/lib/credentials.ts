import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import chalk from 'chalk'
import inquirer from 'inquirer'

// Extracted out of commands/init.ts (originally private to it) so
// `biffo sibling create` (ADR-0007) can resolve GitHub/AWS credentials the
// exact same way `biffo init` does, without duplicating ~250 lines of
// credential-detection/prompting logic. Behaviour is unchanged from before
// the extraction — init.ts's own tests still pass unmodified.

export async function resolveGithubToken(nonInteractive = false): Promise<string> {
  // 1. Explicit env var
  if (process.env['GITHUB_TOKEN']) return process.env['GITHUB_TOKEN']

  // 2. gh CLI (installed and authenticated)
  const ghCreds = tryGhCliToken()
  if (ghCreds) {
    console.log(
      chalk.green('  ✔') + ` GitHub account ${chalk.bold(ghCreds.login)} detected (via gh CLI)\n`,
    )

    const confirmed =
      nonInteractive ||
      (
        await inquirer.prompt<{ confirmed: boolean }>([
          {
            type: 'confirm',
            name: 'confirmed',
            message: 'Use these GitHub credentials?',
            default: true,
          },
        ])
      ).confirmed

    if (confirmed) {
      console.log()
      process.env['GITHUB_TOKEN'] = ghCreds.token
      return ghCreds.token
    }
    console.log()
  }

  if (nonInteractive) {
    throw new Error(
      'No GitHub credentials found. Set GITHUB_TOKEN or run `gh auth login` before using --config/--yes.',
    )
  }

  // 3. Manual entry
  console.log(
    chalk.yellow('  ℹ  No GitHub credentials found.\n') +
      '     Option A: run `gh auth login` to authenticate via the gh CLI\n' +
      '     Option B: create a classic PAT at https://github.com/settings/tokens\n' +
      '               with scopes: repo, workflow, admin:org (if using an org)\n',
  )

  const { token } = await inquirer.prompt<{ token: string }>([
    {
      type: 'password',
      name: 'token',
      message: 'GitHub Personal Access Token:',
      validate: (v: string) => v.trim().length > 0 || 'Token is required',
    },
  ])

  process.env['GITHUB_TOKEN'] = token
  return token
}

function tryGhCliToken(): { token: string; login: string } | null {
  try {
    const token = execSync('gh auth token', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim()
    if (!token) return null
    const login = execSync('gh api user --jq .login', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim()
    return login ? { token, login } : null
  } catch {
    return null
  }
}

export async function resolveAwsCredentials(nonInteractive = false): Promise<{
  accountId: string
  region: string
  profile?: string
}> {
  const profile = process.env['AWS_PROFILE'] ?? process.env['AWS_DEFAULT_PROFILE'] ?? 'default'
  const detectedRegion =
    process.env['AWS_DEFAULT_REGION'] ?? process.env['AWS_REGION'] ?? 'us-east-1'

  let detectedAccountId: string | undefined

  try {
    const sts = new STSClient({ region: detectedRegion })
    const identity = await sts.send(new GetCallerIdentityCommand({}))
    detectedAccountId = identity.Account
  } catch {
    // Credentials not configured or invalid — fall through to manual entry
  }

  if (detectedAccountId) {
    console.log(
      chalk.green(`  ✔`) +
        ` AWS account ${chalk.bold(detectedAccountId)} detected` +
        ` (${detectedRegion}, profile: ${profile})\n`,
    )

    const confirmed =
      nonInteractive ||
      (
        await inquirer.prompt<{ confirmed: boolean }>([
          {
            type: 'confirm',
            name: 'confirmed',
            message: 'Use these AWS credentials?',
            default: true,
          },
        ])
      ).confirmed

    if (confirmed) {
      console.log()
      return { accountId: detectedAccountId, region: detectedRegion, profile }
    }
  } else {
    console.log(
      chalk.yellow('  ⚠  Could not detect AWS credentials.\n') +
        '     Run: aws configure\n' +
        '     Or set AWS_PROFILE to switch profiles.\n',
    )
  }

  if (nonInteractive) {
    throw new Error(
      'Could not detect AWS credentials. Run `aws configure` or set AWS_PROFILE before using --config/--yes.',
    )
  }

  return promptForAwsProfile(detectedRegion)
}

async function promptForAwsProfile(
  detectedRegion: string,
): Promise<{ accountId: string; region: string; profile?: string }> {
  const profiles = discoverAwsProfiles()

  if (profiles.length > 0) {
    const answers = await inquirer.prompt<{
      selected_profile: string
      profile: string
      region: string
    }>([
      {
        type: 'list',
        name: 'selected_profile',
        message: 'AWS profile for the target account:',
        choices: [
          ...profiles.map((p) => ({ name: p, value: p })),
          { name: 'Enter another profile name', value: '__manual__' },
          { name: 'Use current environment credentials', value: '' },
        ],
        default: profiles.includes('default') ? 'default' : profiles[0],
      },
      {
        type: 'input',
        name: 'profile',
        message: 'AWS profile name:',
        when: (a: { selected_profile?: string }) => a.selected_profile === '__manual__',
        validate: (v: string) => v.trim().length > 0 || 'Profile is required',
      },
      {
        type: 'input',
        name: 'region',
        message: 'AWS region:',
        default: detectedRegion,
      },
    ])

    const selectedProfile =
      answers.selected_profile === '__manual__' ? answers.profile.trim() : answers.selected_profile
    const identity = await verifySelectedAwsCredentials(selectedProfile, answers.region)
    if (!identity.Account) {
      throw new Error(
        `AWS profile ${selectedProfile || '<environment>'} did not return an account ID.`,
      )
    }

    console.log(
      chalk.green('  ✔') +
        ` AWS profile ${chalk.bold(selectedProfile || '<environment>')} resolves to account ${chalk.bold(identity.Account!)}\n`,
    )
    return {
      accountId: identity.Account!,
      region: answers.region,
      ...(selectedProfile ? { profile: selectedProfile } : {}),
    }
  }

  const answers = await inquirer.prompt<{ account_id: string; region: string }>([
    {
      type: 'input',
      name: 'account_id',
      message: 'AWS account ID (12 digits):',
      validate: (v: string) => /^\d{12}$/.test(v) || 'Must be 12 digits',
    },
    {
      type: 'input',
      name: 'region',
      message: 'AWS region:',
      default: detectedRegion,
    },
  ])

  process.env['AWS_REGION'] = answers.region
  process.env['AWS_DEFAULT_REGION'] = answers.region
  const identity = await verifySelectedAwsCredentials('', answers.region)
  if (identity.Account !== answers.account_id) {
    throw new Error(
      `AWS credentials resolve to account ${identity.Account}, expected ${answers.account_id}.\n` +
        `  Select an AWS profile for ${answers.account_id}, or export credentials for that account and rerun the command.`,
    )
  }

  console.log()
  return { accountId: answers.account_id, region: answers.region }
}

async function verifySelectedAwsCredentials(
  profile: string,
  region: string,
): Promise<{ Account?: string | undefined }> {
  if (profile) {
    process.env['AWS_PROFILE'] = profile
    process.env['AWS_DEFAULT_PROFILE'] = profile
    process.env['AWS_SDK_LOAD_CONFIG'] = '1'
  }
  process.env['AWS_REGION'] = region
  process.env['AWS_DEFAULT_REGION'] = region

  const sts = new STSClient({ region })
  return sts.send(new GetCallerIdentityCommand({}))
}

function discoverAwsProfiles(): string[] {
  const files = [join(homedir(), '.aws', 'credentials'), join(homedir(), '.aws', 'config')]
  const profiles = new Set<string>()

  for (const file of files) {
    if (!existsSync(file)) continue
    const content = readFileSync(file, 'utf8')
    for (const match of content.matchAll(/^\s*\[([^\]]+)\]\s*$/gm)) {
      const section = match[1]?.trim()
      if (!section) continue
      profiles.add(section === 'default' ? 'default' : section.replace(/^profile\s+/, ''))
    }
  }

  return [...profiles].sort((a, b) =>
    a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b),
  )
}
