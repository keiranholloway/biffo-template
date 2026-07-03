# biffo-pr-signer

The isolated PR-signer for the endpoint control plane (**ADR-0008**).

It exists so the repo-write credential is **not** held by the Core API. The
Core API authenticates and authorizes an admin's request, then invokes this
function over IAM; this function alone holds the GitHub App credential and does
the privileged act: edit a plugin's `permissions` block and open a pull request.
Merging the PR deploys the change through the normal pipeline — nothing goes
live at runtime (config-as-code is preserved; ADR-0004).

## What's here today (Phase 1)

- `permission_edit.apply_permission_change` — pure: patch one table/operation's
  permission in a manifest's JSON, re-validated against `TablePermissions`.
- `pr.open_permission_pr` — orchestration: read the manifest, apply the change,
  and open a PR attributing the requesting admin, via an injected GitHub client.

Later phases add the App-authenticated GitHub client (short-lived, single-repo
installation token via the Contents API), the Lambda handler, and its infra/IAM.
