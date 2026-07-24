output "distribution_id" { value = aws_cloudfront_distribution.portal.id }
output "distribution_domain" { value = aws_cloudfront_distribution.portal.domain_name }
output "oac_id" { value = aws_cloudfront_origin_access_control.portal.id }
# ARN of the distribution — used by a user-facing plugin's frontend bucket policy
# to grant read access to THIS distribution only (ADR-0018 §2 / AWS:SourceArn).
output "distribution_arn" { value = aws_cloudfront_distribution.portal.arn }
