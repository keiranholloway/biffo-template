output "hosted_zone_id" {
  value       = aws_route53_zone.main.zone_id
  description = "Route 53 hosted zone ID — pass to environment Terraform as TF_VAR_hosted_zone_id"
}

output "name_servers" {
  value       = aws_route53_zone.main.name_servers
  description = "Delegate these NS records at your domain registrar to activate DNS"
}

output "acm_certificate_arn" {
  value       = aws_acm_certificate_validation.wildcard.certificate_arn
  description = "Validated wildcard cert ARN — set as ACM_CERTIFICATE_ARN GitHub variable"
}
