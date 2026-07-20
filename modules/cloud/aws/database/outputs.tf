output "db_instance_id" {
  value = aws_db_instance.main.id
}

output "db_endpoint" {
  description = "Endpoint for the Lambda to connect to — proxy endpoint when enabled, direct RDS address otherwise"
  value       = local.db_address
}

output "credentials_secret_arn" {
  description = "Secrets Manager ARN — grant GetSecretValue to the Core API Lambda role only (ADR-0002)"
  value       = aws_secretsmanager_secret.db_credentials.arn
}

output "app_credentials_secret_arn" {
  description = "Secrets Manager ARN for the least-privilege application role (#253) — inject as BIFFO_APP_DB_SECRET_ARN where the Lambda can reach Secrets Manager"
  value       = aws_secretsmanager_secret.app_credentials.arn
}

output "app_db_user" {
  description = "Name of the least-privilege role — inject as BIFFO_APP_ROLE_NAME so db-init's cross-check against the secret's username agrees"
  value       = var.app_db_user
}

output "security_group_id" {
  value = aws_security_group.db.id
}

output "db_url" {
  description = "Full asyncpg URL for the MASTER/owner user — inject as BIFFO_DATABASE_URL in dev so Lambda needs no Secrets Manager call (and therefore no NAT or VPC endpoint). Used by migrations, biffo:db-init and biffo:ddl-import, which create and alter objects. Sensitive: stored in Terraform state."
  sensitive   = true
  value       = "postgresql+asyncpg://${local.db_user}:${random_password.db_password.result}@${local.db_address}:5432/${local.db_name}"
}

output "app_db_url" {
  description = "Full asyncpg URL for the least-privilege application role (#253) — inject as BIFFO_APP_DATABASE_URL in dev, alongside (not instead of) db_url. The request path uses this one. Sensitive: stored in Terraform state."
  sensitive   = true
  value       = "postgresql+asyncpg://${var.app_db_user}:${random_password.app_password.result}@${local.db_address}:5432/${local.db_name}"
}
