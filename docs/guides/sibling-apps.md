# Guide: Creating a Sibling App (`biffo sibling create`)

A **sibling app** is an independently-deployed microservice repo that still feels like part of your product: it shares your core project's login (same Cognito User Pool and App Client — no second sign-in, no OAuth redirect), lives on the same domain (`baseurl.com/<name>`), and has its own repo, its own CI/CD, its own AWS resources. It never touches your database directly — it only ever calls your core project's own API.

For the design rationale (why it works this way, not how to use it), see [ADR-0007](../ADR/0007-sibling-applications.md).

## Prerequisites

- A core Biffo project that's already been through `biffo init` **and deployed** (`biffo deploy <environment>`) to every environment you want this sibling to run in. `biffo sibling create` reads that deployment's real Terraform outputs (Cognito pool/client IDs, API URL, portal URL) — it fails with a clear error if the core project hasn't been deployed to a given environment yet.
- A GitHub token with `repo`, `workflow`, and `admin:org` (if using an org) scopes, resolved the same way `biffo init` resolves one: `GITHUB_TOKEN` env var, or `gh auth login`. Unlike `biffo init`, `biffo sibling create` does **not** prompt interactively for a token — it needs one of these two to already be in place.
- AWS credentials (env vars, or `AWS_PROFILE`) that resolve to the AWS account you want _this sibling's own_ resources created in — usually the same account as your core project, but doesn't have to be.
- A configured **global** git identity (`git config --global user.name`/`user.email`). The skeleton-push step (step 3 below) commits into a fresh temporary directory outside any existing repo, so it has no repo-local config to fall back to — with neither set, `git commit` fails there with `Author identity unknown`, which looks unrelated to `biffo sibling create` itself if you don't already know this.

## 1. Write a `biffo.sibling.json`

Unlike `biffo init`, there's no interactive prompt flow — you hand-write (or script) a small config file first:

```json
{
  "project": {
    "name": "reports",
    "description": "Usage reports for the core dashboard"
  },
  "source_control": {
    "provider": "github",
    "config": { "org": "acme", "repo": "reports" }
  },
  "cloud": {
    "provider": "aws",
    "config": { "account_id": "123456789012", "region": "eu-west-1" }
  },
  "environments": ["dev"],
  "core": {
    "project_name": "acme-core"
  }
}
```

| Field                   | Meaning                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.name`          | Lowercase, hyphenated, starts with a letter — becomes both this sibling's repo name and its default path segment (`baseurl.com/<name>`).                                           |
| `source_control.config` | The GitHub org/user and repo name for the **new** sibling repo (not yet created — this command creates it).                                                                        |
| `cloud.config`          | This sibling's own AWS account/region. Its Terraform state, IAM role, and infrastructure all live here.                                                                            |
| `environments`          | Which environments to provision (`dev`, `staging`, `prod`). Defaults to `["dev"]`. Each one needs the core project already deployed to it (see Prerequisites).                     |
| `core.project_name`     | Name of the core project as scaffolded with `biffo init` **on this machine** (i.e. it has a `~/.biffo/projects/<name>.json`). Use this if you ran `biffo init` here.               |
| `core.config_path`      | Alternative to `core.project_name` — a path to the core project's `biffo.config.json` directly, for when it wasn't scaffolded on this machine. Exactly one of the two is required. |
| `core.path_prefix`      | Optional — the path segment this sibling is routed on, if you want it to differ from `project.name`. Defaults to `project.name`.                                                   |

## 2. Run it

```bash
npx @biffo/cli sibling create reports --config biffo.sibling.json
```

(`reports` must match `project.name` in the config — this is a safety check, not a second place to set the name.)

What happens, in order:

1. **Verify AWS credentials** — confirms your ambient AWS credentials resolve to the account ID in `cloud.config`.
2. **Resolve the core project's identity** — reads the core project's real Terraform outputs (Cognito pool/client IDs, API URL, portal URL) for each environment in `environments`. Each environment has its own Cognito pool, so this happens once per environment, not once overall.
3. **Create the GitHub repo** — creates `<org>/<repo>` as a plain, empty, private repo and pushes the sibling skeleton (Next.js frontend + FastAPI backend + Terraform) in as its first commit.
4. **AWS OIDC trust** — same as `biffo init`, a dedicated IAM role this sibling's own GitHub Actions can assume.
5. **Terraform state bucket** — this sibling's own, separate from the core project's.
6. **Configure GitHub** — branches (`dev`/`staging`/`main`), branch protection (the same 11-check governance the core project has), GitHub Environments, and repo/environment variables (including the core project's Cognito/API details from step 2, wired in per environment).
7. **Register with the core project** — clones the core project's repo, adds this sibling's entry to `infra/environments/<env>/siblings.auto.tfvars.json` for each environment, and **opens a pull request** against the core project. This is the one step that touches a different repo than the one just created.

The command prints the new repo's URL and the registration PR's URL when it finishes.

```
  Sibling repo created successfully!

  Repository: https://github.com/acme/reports
  Path:       /reports
  Registration PR (against acme-core): https://github.com/acme/acme-core/pull/42
```

If it fails partway through (network blip, a typo in the config, credentials that don't resolve), just re-run the same command — completed steps are skipped, not repeated, so it's always safe to try again. Pass `--fresh` to ignore any saved progress and start over from step 1.

## 3. Finish wiring the new repo

The command's own output ends with these steps — do them in order:

1. **Merge the registration PR** it opened against your core project. Until this merges (and the core project redeploys), `baseurl.com/<name>` doesn't route anywhere yet.
2. **Add a `SIBLING_GITHUB_TOKEN` secret** to the new sibling repo (Settings → Secrets and variables → Actions) — a personal access token with `repo` scope. Its own deploy workflow uses this to write Terraform outputs back as GitHub Environment variables, the same way the core project's own deploy workflow does.
3. **Push to `dev`** (or trigger the "Deploy" workflow manually) in the new sibling repo. This runs its own `terraform apply`, builds the frontend, and deploys the Lambda — none of this happens as part of `biffo sibling create` itself, which only talks to the GitHub and AWS _control planes_, never runs Terraform directly.
4. **Complete the CDN registration's second phase.** The sibling's own bucket policy needs the core project's real CloudFront distribution ARN, which only exists after step 1 above has merged and the core project has redeployed. Once that's true, set `PARENT_CLOUDFRONT_DISTRIBUTION_ARN` (and `PARENT_CLOUDFRONT_DISTRIBUTION_ID`, for cache invalidation) as GitHub Environment variables on the sibling repo, then re-run its Deploy workflow. This two-phase ordering is by design — see ADR-0007's "two-phase CDN registration" for why it can't be one-phase.

## 4. Verify it

Once both deploys (core project's redeploy after the registration PR, and the sibling's own deploy) have gone through, visit `baseurl.com/<name>` while already signed into the core portal in the same browser. You should land straight on:

```
<name> - Hello <your-username>
```

with no second login — this is the shared-Cognito-session SSO from ADR-0007 working end to end. If you land on a spinner or get bounced to `/login`, see Troubleshooting below.

## Troubleshooting

**`cognito_user_pool_id not found in <core>'s Terraform outputs for <env>`** — the core project hasn't been deployed to that environment yet. Run `biffo deploy <env>` from the core project first, then re-run `biffo sibling create`.

**`No project named '<name>' found`** (from `core.project_name`) — either the core project wasn't scaffolded with `biffo init` on _this_ machine, or the name doesn't match. Use `core.config_path` pointing at the core project's `biffo.config.json` instead.

**`No GitHub credentials found. Set GITHUB_TOKEN or run gh auth login`** — `biffo sibling create` never prompts for a token interactively; set one of these two first.

**`Author identity unknown` / `git commit` fails while "Creating GitHub repository and pushing sibling skeleton..."** — no global git identity is configured on this machine (see Prerequisites). Run `git config --global user.name "..."` and `git config --global user.email "..."`, then re-run `biffo sibling create` — it's resumable, so this picks up right where it left off.

**Stuck on a spinner at `baseurl.com/<name>`** — check the sibling's own `/api/v1/whoami` endpoint is reachable (its own API Gateway + Lambda must be deployed — step 3 in "Finish wiring the new repo"). The page calls this to independently re-verify the session before rendering.

**Redirected to `/login` even though you're already signed in on the core portal** — confirm the sibling's `NEXT_PUBLIC_CORE_COGNITO_USER_POOL_ID`/`NEXT_PUBLIC_CORE_COGNITO_CLIENT_ID` build-time env vars actually match the core project's own (they're wired automatically from step 2/6 above, via GitHub Environment variables — if you're testing a config change, remember the frontend build only picks these up on its **next** CI build, not retroactively).

**`baseurl.com/<name>` still 404s / doesn't route** — the registration PR (step 7, then step 1 in "Finish wiring the new repo") hasn't merged yet, or the core project hasn't redeployed its CDN since it merged.
