output "function_arn" { value = aws_lambda_function.main.arn }
output "function_name" { value = aws_lambda_function.main.function_name }
output "security_group_id" { value = aws_security_group.lambda.id }
output "role_arn" { value = aws_iam_role.lambda.arn }
output "dlq_arn" { value = aws_sqs_queue.dlq.arn }
