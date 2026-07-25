# Endpoint control plane — isolated PR-signer (ADR-0008).
# Template-owned core infrastructure (like plugins.core.tf and
# plugin-host.core.tf): pr-signer is the only component in the repo that holds
# the GitHub App credential, so every instance needs it provisioned identically
# and it must ride `biffo core upgrade` rather than drift (#568 — same #243
# gap the other two carve-outs fixed).
#
# The signer is the only component that holds the GitHub App credential. The
# Core API authorizes an admin's request and invokes this function over IAM
# (see invoke_function_arns on module.core_api in main.tf); the signer then
# edits a plugin's permissions block and opens a PR. Nothing goes live until
# that PR is merged through the normal pipeline — config-as-code is preserved
# (ADR-0004).
#
# Gated on enable_pr_signer: creating a live GitHub App is a manual setup step
# (docs/guides/endpoint-control-plane-setup.md), so the platform stands up
# without one. That toggle (and its companion pr_signer_* variables) stays in
# the user-owned variables.tf — it is legitimately per-instance policy, not
# something the template should force on every instance the way the signer's
# own infrastructure is. The App private key is uploaded to the secret below
# out-of-band; it is never stored in Terraform state.
#
# This file depends only on the template-seeded shape every instance has
# (var.project_name, local.environment, local.tags, aws_kms_key.logs — all
# defined in main.tf) plus the per-instance pr_signer_* variables, the same
# cross-file pattern plugin-host.core.tf uses for module.auth/module.events/
# module.api_gateway. module.core_api (main.tf) references module.pr_signer's
# outputs back (invoke_function_arns, BIFFO_PR_SIGNER_FUNCTION_NAME) — that
# direction of reference could not move here without editing module.core_api's
# own block, which is outside this carve-out's scope; see the comment on
# module.core_api in main.tf.
check "pr_signer_config" {
  assert {
    condition = !var.enable_pr_signer || (
      var.pr_signer_github_app_id != "" &&
      var.pr_signer_github_installation_id != "" &&
      var.pr_signer_repo_owner != "" &&
      var.pr_signer_repo_name != ""
    )
    error_message = "enable_pr_signer requires pr_signer_github_app_id, pr_signer_github_installation_id, pr_signer_repo_owner and pr_signer_repo_name to be set."
  }
}

resource "aws_secretsmanager_secret" "pr_signer_github_app_key" {
  count                   = var.enable_pr_signer ? 1 : 0
  name                    = "/${var.project_name}/${local.environment}/pr-signer/github-app-key"
  description             = "GitHub App private key (PEM) for the endpoint control-plane PR-signer (ADR-0008). Value is uploaded out-of-band; never stored in Terraform."
  recovery_window_in_days = local.environment == "prod" ? 30 : 0
  tags                    = local.tags
}

module "pr_signer" {
  source = "../../../modules/cloud/aws/compute"
  count  = var.enable_pr_signer ? 1 : 0

  project_name          = var.project_name
  environment           = local.environment
  function_name         = "pr-signer"
  handler               = "src.pr_signer.handler.handler"
  timeout               = 30
  cloudwatch_kms_key_id = aws_kms_key.logs.arn
  # No VPC: the signer calls the public GitHub API and touches no database
  # (ADR-0002). In this NAT-less env a VPC-attached Lambda couldn't reach GitHub.
  enable_vpc_access    = false
  readable_secret_arns = [aws_secretsmanager_secret.pr_signer_github_app_key[0].arn]
  environment_variables = {
    BIFFO_ENVIRONMENT                     = local.environment
    BIFFO_PR_SIGNER_APP_ID                = var.pr_signer_github_app_id
    BIFFO_PR_SIGNER_INSTALLATION_ID       = var.pr_signer_github_installation_id
    BIFFO_PR_SIGNER_REPO_OWNER            = var.pr_signer_repo_owner
    BIFFO_PR_SIGNER_REPO_NAME             = var.pr_signer_repo_name
    BIFFO_PR_SIGNER_PRIVATE_KEY_SECRET_ID = aws_secretsmanager_secret.pr_signer_github_app_key[0].arn
    BIFFO_PR_SIGNER_BASE_BRANCH           = var.pr_signer_base_branch
  }
  tags = local.tags
}
