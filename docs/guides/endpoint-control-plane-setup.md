# Setting up the endpoint control plane (PR-signer)

The endpoint control plane (**ADR-0008**) lets an admin change a plugin table's
API permissions from the portal without hand-editing files. It does this the
safe way: the change is turned into a **pull request**, and nothing goes live
until that PR is merged through the normal pipeline. Config-as-code is preserved
(ADR-0004) — there is no runtime toggle that mutates a live permission.

The privileged part — holding a credential that can write to your repo — is
isolated in a dedicated **PR-signer** Lambda. The Core API never holds that
credential; it only authorizes the admin and invokes the signer over IAM.

```
Portal ─► Core API (authorizes admin, validates) ─IAM invoke─► PR-signer
                                                                    │
                                        GitHub App (single repo,    ▼
                                        contents:write + PRs) ──► opens PR ──► you review & merge
```

This guide is the one-time setup. It has a manual step — registering a GitHub
App — which is why the infrastructure is **off by default** (`enable_pr_signer`).

## Prerequisites

- Admin access to the GitHub org/user that owns the instance repo.
- Ability to `terraform apply` the environment and to run `aws secretsmanager`
  against the target account.

## 1. Register a least-privilege GitHub App

Create a GitHub App (Settings → Developer settings → GitHub Apps → New). Keep it
as narrow as possible — this App can only ever open PRs against one repo:

- **Repository permissions:**
  - **Contents:** Read and write (edit the plugin manifest on a branch)
  - **Pull requests:** Read and write (open the PR)
  - Everything else: **No access**
- **Where can this App be installed?** Only on this account.
- **Webhook:** not needed — untick Active.
- Generate and download a **private key** (PEM). Note the **App ID**.

Then **install** the App and select **only the instance repository**. From the
installation URL (or the API) note the **installation ID**.

You now have three values: **App ID**, **installation ID**, and the **private
key (PEM)**. The first two are configuration; the PEM is a secret.

## 2. Enable the signer in Terraform

In your environment's `terraform.tfvars` (e.g. `infra/environments/dev/`):

```hcl
enable_pr_signer                 = true
pr_signer_github_app_id          = "123456"
pr_signer_github_installation_id = "45678901"
pr_signer_repo_owner             = "my-org"
pr_signer_repo_name              = "my-project"
pr_signer_base_branch            = "main"   # or "dev" on instances that integrate there
```

`terraform apply`. This creates:

- the **PR-signer Lambda** (no VPC — it calls the public GitHub API and touches
  no database),
- a **Secrets Manager secret** for the App private key (empty for now), and
- an IAM grant letting the **Core API** invoke the signer (and only the signer).

The App private key is **never** put in Terraform — only the secret's ARN flows
through the config.

## 3. Upload the App private key to the secret

The secret is created empty; upload the PEM out-of-band. Its name is
`/<project>/<env>/pr-signer/github-app-key`:

```bash
aws secretsmanager put-secret-value \
  --secret-id "/my-project/dev/pr-signer/github-app-key" \
  --secret-string "file://path/to/app-private-key.pem"
```

Store the PEM only where you keep other break-glass secrets, and delete the
local copy afterwards. Rotating the key later is just another `put-secret-value`
(the signer reads the current value each cold start).

## 4. Verify

Once the signer's code is deployed, changing a permission from the portal's
Endpoints view (or invoking the Core API's permission endpoint) should produce a
pull request in your repo, authored by the App and attributing the requesting
admin in the body. Review and merge it as you would any change.

## Security notes

- **Least privilege, single repo.** The App can only edit contents and open PRs
  on the one repo it's installed on. The token the signer mints is short-lived
  (~1 hour) and scoped to that installation.
- **Blast radius is isolated.** Only the PR-signer holds the App credential. A
  compromise of the Core API does not yield repo-write access — the Core API can
  only *ask* the signer to open a PR for an already-authorized change, and every
  such change still requires a human to merge the PR.
- **Auditability.** The signer emits a structured audit log for every PR it
  opens (who requested it, what changed, the resulting branch and PR URL), and
  the PR itself is a durable record reviewed before anything deploys.
- **Never commit the PEM.** It lives only in Secrets Manager. `terraform.tfvars`
  is gitignored; keep the key out of it too — only IDs belong there.

## Remaining wiring

Provisioning (this guide) stands the infrastructure up. Still required before
the flow works end to end:

- **Deploy the signer's code** to its Lambda (the function is created with a
  placeholder; the deploy pipeline must publish `services/pr-signer`).
- **Core API permission endpoint** (`POST /api/v1/admin/endpoints/permission`)
  that authorizes the admin and invokes the signer.
- **Portal enable toggle** on the Endpoints view.

See ADR-0008 for the full design and phase breakdown.
