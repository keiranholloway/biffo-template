output "portal_bucket_name" { value = aws_s3_bucket.portal.bucket }
output "portal_bucket_arn" { value = aws_s3_bucket.portal.arn }
output "portal_bucket_regional_domain" { value = aws_s3_bucket.portal.bucket_regional_domain_name }
output "logs_bucket_name" { value = aws_s3_bucket.logs.bucket }
