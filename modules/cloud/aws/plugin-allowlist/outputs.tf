output "arns" {
  description = <<-EOT
    Assumed-role ARN globs for the enabled plugins, for
    BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST on the Core API Lambda. Empty when no
    plugins are enabled — require_service_principal then accepts no service
    caller (ADR-0009).
  EOT
  value       = local.service_principal_arns
}

output "account_id" {
  description = "The account the allowlisted roles live in, for callers that would otherwise declare their own aws_caller_identity data source."
  value       = data.aws_caller_identity.current.account_id
}
