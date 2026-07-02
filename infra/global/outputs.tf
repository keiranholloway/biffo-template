output "hosted_zone_id" {
  value       = try(aws_route53_zone.main[0].zone_id, "")
  description = "Route 53 hosted zone ID — pass to environment Terraform as TF_VAR_hosted_zone_id"
}

output "name_servers" {
  value       = try(aws_route53_zone.main[0].name_servers, [])
  description = "Delegate these NS records at your domain registrar to activate DNS"
}

output "acm_certificate_arn" {
  value       = aws_acm_certificate.wildcard.arn
  description = "Wildcard certificate ARN. In external DNS mode this may still be pending DNS validation."
}

output "certificate_validation_records" {
  value = [
    for dvo in aws_acm_certificate.wildcard.domain_validation_options : {
      domain = dvo.domain_name
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      value  = dvo.resource_record_value
    }
  ]
  description = "DNS records required to validate the ACM certificate."
}
