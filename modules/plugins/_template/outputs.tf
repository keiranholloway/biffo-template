output "function_arn" {
  description = "Lambda function ARN — aggregate this in the root config's plugin outputs."
  value       = module.function.function_arn
}

output "function_name" {
  value = module.function.function_name
}

output "role_arn" {
  value = module.function.role_arn
}

output "dlq_arn" {
  description = "Dead letter queue ARN for failed invocations (both direct and EventBridge-triggered)."
  value       = module.function.dlq_arn
}

output "event_rule_arn" {
  description = "EventBridge rule ARN, or null when the plugin declares no event_subscriptions."
  value       = local.has_subscriptions ? aws_cloudwatch_event_rule.subscription[0].arn : null
}
