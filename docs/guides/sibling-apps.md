# Guide: Creating a Sibling App (`biffo sibling create`)

A **sibling app** is an independently-deployed microservice repo that still feels like part of your product: it shares your core project's login (same Cognito User Pool and App Client — no second sign-in, no OAuth redirect), lives on the same domain (`baseurl.com/<name>`), and has its own repo, its own CI/CD, its own AWS resources. It never touches your database directly — it only ever calls your core project's own API.

For the design rationale (why it works this way, not how to use it), see [ADR-0007](../ADR/0007-sibling-applications.md).

## Prerequisites

- A core Biffo project that's already been through `biffo init` **and deployed** (`biffo deploy <environment>`) to every environment you want this sibling to run in. `biffo sibling create` reads that deployment's real Terraform outputs (Cognito pool/client IDs, API URL, portal URL) — it fails with a clear error if the core project hasn't been deployed to a given environment yet.
- The core project's template must include **ADR-0007 sibling CDN routing** (the `sibling_origins` variable in `modules/cloud/aws/cdn`). A project scaffolded before ADR-0007 needs to run `biffo core upgrade` first — otherwise the registration PR would merge cleanly but CloudFront would never actually route the sibling. `biffo sibling create` now checks this up front and fails with an actionable message if it's missing (issue #151).
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

As of `sibling-wiring.ts` (#337), steps 2 and 4 below are **no longer manual** —
they used to be, and this section drifted ~3.5 weeks out of date describing
already-automated work as something to do by hand (biffo-template#737). The
only remaining manual step is the human review gate in step 1:

1. **Merge the registration PR** it opened against your core project. Until this merges, `baseurl.com/<name>` doesn't route anywhere yet.
2. **Deploy the core project** (`biffo deploy <environment>`, or push to the core project's own `dev`). Its deploy workflow now automatically pushes `CORE_COGNITO_USER_POOL_ID`, `CORE_COGNITO_CLIENT_ID`, `CORE_API_URL`, `CORE_PORTAL_URL`, the `SIBLING_GITHUB_TOKEN` repo secret, and (once the registration PR has merged) `PARENT_CLOUDFRONT_DISTRIBUTION_ARN`/`_ID` to **every registered sibling**, at the matching environment scope. **Do not set any of these by hand** — a manually-set value can conflict with what the next core deploy writes, and the whole point of `sibling-wiring.ts` is that nothing here needs a person.
3. **Push to `dev`** (or trigger the "Deploy" workflow manually) in the new sibling repo. This runs its own `terraform apply`, builds the frontend, and deploys the Lambda — none of this happens as part of `biffo sibling create` itself, which only talks to the GitHub and AWS _control planes_, never runs Terraform directly. If step 2 hasn't happened yet for this environment, the sibling's own deploy still runs but the app is pointed at nothing until it does — re-run this Deploy workflow after the core project's next deploy.

Two-phase CDN registration (the sibling's bucket policy needing the core's real CloudFront ARN, which only exists after the registration PR has merged) still can't be one-phase — see ADR-0007 — but the second phase is now automatic too: `sibling-wiring.ts` fires from `biffo deploy` (the CORE deploy), the first moment every value exists at once, and pushes `PARENT_CLOUDFRONT_DISTRIBUTION_ARN`/`_ID` itself. You do not need to read Terraform state or set these variables by hand.

## 4. Verify it

Once both deploys (core project's redeploy after the registration PR, and the sibling's own deploy) have gone through, visit `baseurl.com/<name>` while already signed into the core portal in the same browser. You should land straight on:

```
<name> - Hello <your-username>
```

with no second login — this is the shared-Cognito-session SSO from ADR-0007 working end to end. If you land on a spinner or get bounced to `/login`, see Troubleshooting below.

**A green deploy is not evidence the route works.** `deploy.yml`'s "Smoke test the deployed Lambda" step (#162) only proves the Lambda boots; a separate "Smoke test the CDN routing" step (#737) checks the actual `dev.<domain>/<path>` route the browser above hits — the bare path, the trailing-slash path, and that CloudFront is genuinely serving this sibling rather than silently falling through to the core project's default behaviour. Both run automatically on every deploy; you shouldn't need to check this by hand, but if you're diagnosing a stuck spinner, `scripts/routing-smoke-test.sh`'s output in that step is the first place to look before assuming the Lambda is at fault.

## Troubleshooting

**`cognito_user_pool_id not found in <core>'s Terraform outputs for <env>`** — the core project hasn't been deployed to that environment yet. Run `biffo deploy <env>` from the core project first, then re-run `biffo sibling create`.

**`No project named '<name>' found`** (from `core.project_name`) — either the core project wasn't scaffolded with `biffo init` on _this_ machine, or the name doesn't match. Use `core.config_path` pointing at the core project's `biffo.config.json` instead.

**`No GitHub credentials found. Set GITHUB_TOKEN or run gh auth login`** — `biffo sibling create` never prompts for a token interactively; set one of these two first.

**`Author identity unknown` / `git commit` fails while "Creating GitHub repository and pushing sibling skeleton..."** — no global git identity is configured on this machine (see Prerequisites). Run `git config --global user.name "..."` and `git config --global user.email "..."`, then re-run `biffo sibling create` — it's resumable, so this picks up right where it left off.

**Stuck on a spinner at `baseurl.com/<name>`** — check the sibling's own `/api/v1/whoami` endpoint is reachable (its own API Gateway + Lambda must be deployed — step 3 in "Finish wiring the new repo"). The page calls this to independently re-verify the session before rendering.

**Redirected to `/login` even though you're already signed in on the core portal** — the sibling's frontend does **not** read a build-time env var for this (that mechanism was removed in issue #403). Instead, on every page load it resolves the core's Cognito coordinates at runtime via a same-origin fetch of `/.well-known/biffo-identity.json`, published by the core portal; a fetch that fails, or a document missing either id, is treated as "signed out" with **no** baked fallback, so you land on `/login` rather than trust a stale value. First, confirm the document itself is reachable and correct — open `baseurl.com/.well-known/biffo-identity.json` directly and check its `userPoolId`/`clientId` match the core project's live Cognito pool for that environment. Then run `biffo sibling check-identity` from the core project's repo: it reads the core's live Terraform outputs, fetches that same published document, and reads each registered sibling's baked backend `CORE_COGNITO_USER_POOL_ID` GitHub Environment variable, reporting exactly which one (published document, or a specific sibling's backend) has drifted from the live pool — this is the diagnostic this exact symptom calls for, most commonly seen after a Cognito pool rotation.

**`baseurl.com/<name>` still 404s / doesn't route** — the registration PR (step 7, then step 1 in "Finish wiring the new repo") hasn't merged yet, or the core project hasn't redeployed its CDN since it merged.
