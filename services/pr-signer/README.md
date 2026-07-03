# biffo-pr-signer

The isolated PR-signer for the endpoint control plane (**ADR-0008**).

It exists so the repo-write credential is **not** held by the Core API. The
Core API authenticates and authorizes an admin's request, then invokes this
function over IAM; this function alone holds the GitHub App credential and does
the privileged act: edit a plugin's `permissions` block and open a pull request.
Merging the PR deploys the change through the normal pipeline — nothing goes
live at runtime (config-as-code is preserved; ADR-0004).

## What's here today

**Phase 1 — pure logic (GitHub-agnostic):**

- `permission_edit.apply_permission_change` — pure: patch one table/operation's
  permission in a manifest's JSON, re-validated against `TablePermissions`.
- `pr.open_permission_pr` — orchestration: read the manifest, apply the change,
  and open a PR attributing the requesting admin, via an injected `GitHubContents`.

**Phase 2 — App-authenticated GitHub client:**

- `github_app.GitHubAppContents` — the real `GitHubContents` implementation. It
  authenticates as a **GitHub App** installed on a single repository:

  ```
  App private key (RS256) ─► App JWT (~10 min) ─► installation access token
  (~1 h, single repo, contents:write + pull_requests:write) ─► REST calls
  ```

  The installation token is cached until just before expiry and is **never
  logged**. Only the Contents/Git-refs/Pulls REST surface `pr.py` needs is
  implemented. The long-lived App private key lives in Secrets Manager and is
  used only to sign JWTs — it is never handed to the data plane.

## Still to come

- The Lambda handler: read the App key from Secrets Manager, build
  `GitHubAppContents.for_installation(...)`, call `open_permission_pr`, emit the
  audit record, return the PR URL.
- Terraform/IAM: the signer Lambda + its Secrets Manager read, and the Core API
  role's `lambda:InvokeFunction` grant on the signer (no public endpoint).
- Core API `POST /api/v1/admin/endpoints/permission` (admin authz + validate +
  invoke signer) and the portal enable toggle.
