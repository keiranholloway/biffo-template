output "function_arn" { value = aws_lambda_function.main.arn }
output "function_name" { value = aws_lambda_function.main.function_name }
output "security_group_id" {
  description = "SG ID when vpc_id is set, otherwise null (function is not VPC-attached)."
  value       = var.vpc_id != "" ? aws_security_group.lambda[0].id : null
}
output "role_arn" { value = aws_iam_role.lambda.arn }
output "role_name" { value = aws_iam_role.lambda.name }
output "dlq_arn" { value = aws_sqs_queue.dlq.arn }
