output "db_instance_id" {
  value = aws_db_instance.main.id
}

output "proxy_endpoint" {
  description = "RDS Proxy endpoint — use this in application config, not the direct DB endpoint"
  value       = aws_db_proxy.main.endpoint
}

output "credentials_secret_arn" {
  description = "Secrets Manager ARN — grant GetSecretValue to the Core API Lambda role only (ADR-0002)"
  value       = aws_secretsmanager_secret.db_credentials.arn
}

output "security_group_id" {
  value = aws_security_group.db.id
}
