output "db_instance_id" {
  value = aws_db_instance.main.id
}

output "db_endpoint" {
  description = "Endpoint for the Lambda to connect to — proxy endpoint when enabled, direct RDS address otherwise"
  value       = var.enable_rds_proxy ? aws_db_proxy.main[0].endpoint : aws_db_instance.main.address
}

output "credentials_secret_arn" {
  description = "Secrets Manager ARN — grant GetSecretValue to the Core API Lambda role only (ADR-0002)"
  value       = aws_secretsmanager_secret.db_credentials.arn
}

output "security_group_id" {
  value = aws_security_group.db.id
}

output "db_url" {
  description = "Full asyncpg URL — inject as BIFFO_DATABASE_URL in dev so Lambda needs no Secrets Manager call (and therefore no NAT or VPC endpoint). Sensitive: stored in Terraform state."
  sensitive   = true
  value       = "postgresql+asyncpg://${local.db_user}:${random_password.db_password.result}@${var.enable_rds_proxy ? aws_db_proxy.main[0].endpoint : aws_db_instance.main.address}:5432/${local.db_name}"
}
