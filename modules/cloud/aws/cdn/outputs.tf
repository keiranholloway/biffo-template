output "distribution_id" { value = aws_cloudfront_distribution.portal.id }
output "distribution_domain" { value = aws_cloudfront_distribution.portal.domain_name }
output "oac_id" { value = aws_cloudfront_origin_access_control.portal.id }
