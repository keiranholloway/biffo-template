output "function_arn" { value = aws_lambda_function.main.arn }
output "function_name" { value = aws_lambda_function.main.function_name }
output "live_alias_name" {
  description = "Name of the alias CI/CD moves to the newest published version after every deploy (#1747). Always \"live\" today; exposed as an output rather than a hardcoded string in every caller so a future rename has one place to change."
  value       = aws_lambda_alias.live.name
}
output "live_alias_arn" {
  description = "ARN of the live alias, i.e. function_arn with the alias qualifier appended. Provided for callers that already depend on this module's outputs; the API Gateway module derives the same ARN itself (var.lambda_function_arn + \":\" + the alias name) so it needs no direct dependency on this module."
  value       = aws_lambda_alias.live.arn
}
output "security_group_id" {
  description = "SG ID when vpc_id is set, otherwise null (function is not VPC-attached)."
  value       = var.vpc_id != "" ? aws_security_group.lambda[0].id : null
}
output "role_arn" { value = aws_iam_role.lambda.arn }
output "role_name" { value = aws_iam_role.lambda.name }
output "dlq_arn" { value = aws_sqs_queue.dlq.arn }
# Effective function configuration, as planned. Exposed so environment-level
# `terraform test` runs (infra/environments/dev/tests/) can assert that instance
# knobs actually reach the Lambda; a test cannot read a module's inner resources.
output "memory_size" { value = aws_lambda_function.main.memory_size }
output "timeout" { value = aws_lambda_function.main.timeout }
output "snap_start_enabled" { value = length(aws_lambda_function.main.snap_start) > 0 }
output "environment_variables" {
  description = "Effective Lambda environment (sensitive: carries DB URLs)."
  value       = aws_lambda_function.main.environment[0].variables
  sensitive   = true
}
