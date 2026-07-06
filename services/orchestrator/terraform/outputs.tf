# The engine Lambda's execution role ARN. The instance must add this to the
# Core API's BIFFO_SERVICE_PRINCIPAL_ARN_ALLOWLIST (ADR-0009) so the Core API
# accepts the engine's SigV4-signed internal calls. At runtime the caller ARN
# is the assumed-role session form, so allowlist it as a glob, e.g.
# arn:aws:sts::<acct>:assumed-role/<role-name>/*.
output "role_arn" { value = module.function.role_arn }

output "function_name" { value = module.function.function_name }
output "function_arn" { value = module.function.function_arn }
