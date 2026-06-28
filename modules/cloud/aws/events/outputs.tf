output "event_bus_name" { value = aws_cloudwatch_event_bus.main.name }
output "event_bus_arn" { value = aws_cloudwatch_event_bus.main.arn }
output "dlq_arn" { value = aws_sqs_queue.dlq.arn }
output "archive_arn" { value = aws_cloudwatch_event_archive.main.arn }
