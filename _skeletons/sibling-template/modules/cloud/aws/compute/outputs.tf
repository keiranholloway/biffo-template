output "function_arn" { value = aws_lambda_function.main.arn }
output "function_name" { value = aws_lambda_function.main.function_name }
output "role_arn" { value = aws_iam_role.lambda.arn }
output "dlq_arn" { value = aws_sqs_queue.dlq.arn }
