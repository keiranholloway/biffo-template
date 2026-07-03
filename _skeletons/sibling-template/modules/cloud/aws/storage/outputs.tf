output "site_bucket_name" { value = aws_s3_bucket.site.bucket }
output "site_bucket_arn" { value = aws_s3_bucket.site.arn }
output "site_bucket_regional_domain" { value = aws_s3_bucket.site.bucket_regional_domain_name }
output "logs_bucket_name" { value = aws_s3_bucket.logs.bucket }
