terraform {
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

resource "github_repository" "main" {
  name        = var.repo_name
  description = var.description
  visibility  = "private"

  is_template          = false
  auto_init            = false
  delete_branch_on_merge = true
  allow_merge_commit   = false
  allow_squash_merge   = true
  allow_rebase_merge   = false
  squash_merge_commit_title   = "PR_TITLE"
  squash_merge_commit_message = "PR_BODY"
}

resource "github_branch_protection" "main" {
  repository_id = github_repository.main.node_id
  pattern       = "main"

  required_status_checks {
    strict = true
    contexts = [
      "ci / lint-js",
      "ci / typecheck",
      "ci / security-secrets",
      "ci / infra-validate",
    ]
  }

  required_pull_request_reviews {
    required_approving_review_count = 1
    dismiss_stale_reviews           = true
    require_code_owner_reviews      = true
  }

  enforce_admins         = true
  require_linear_history = true
  allows_force_pushes    = false
  allows_deletions       = false
}

resource "github_repository_environment" "envs" {
  for_each    = toset(var.environments)
  repository  = github_repository.main.name
  environment = each.key
}

resource "github_actions_secret" "oidc_role_arn" {
  repository      = github_repository.main.name
  secret_name     = "BIFFO_OIDC_ROLE_ARN"
  plaintext_value = var.oidc_role_arn
}

resource "github_actions_variable" "aws_region" {
  repository    = github_repository.main.name
  variable_name = "AWS_REGION"
  value         = var.aws_region
}

resource "github_actions_variable" "portal_bucket_dev" {
  count         = var.portal_bucket_dev != "" ? 1 : 0
  repository    = github_repository.main.name
  variable_name = "PORTAL_BUCKET_NAME"
  value         = var.portal_bucket_dev
}

resource "github_actions_variable" "cloudfront_dev" {
  count         = var.cloudfront_distribution_dev != "" ? 1 : 0
  repository    = github_repository.main.name
  variable_name = "CLOUDFRONT_DISTRIBUTION_ID"
  value         = var.cloudfront_distribution_dev
}
