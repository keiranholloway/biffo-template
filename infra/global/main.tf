terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }

  backend "s3" {}
}

# ACM certificates for CloudFront must be provisioned in us-east-1.
# Route 53 is a global service (endpoint in us-east-1) so both live here.
provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = var.project_name
      ManagedBy = "terraform"
    }
  }
}

locals {
  manage_route53 = var.dns_mode == "managed-route53"

  # The set of names the wildcard certificate validates: the apex and its
  # wildcard. These are derived purely from var.domain (a known input), so the
  # for_each below has statically-known keys.
  cert_validation_domains = [var.domain, "*.${var.domain}"]

  # Values are looked up from the certificate at apply time. Only the map KEYS
  # need to be known during plan/import; the values may be known-after-apply.
  cert_validation_options = {
    for dvo in aws_acm_certificate.wildcard.domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }
}

resource "aws_route53_zone" "main" {
  count = local.manage_route53 ? 1 : 0

  name = var.domain
}

resource "aws_acm_certificate" "wildcard" {
  domain_name               = var.domain
  subject_alternative_names = ["*.${var.domain}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# for_each is keyed off static domain names derived from var.domain rather than
# off aws_acm_certificate.wildcard.domain_validation_options. The latter is a
# set that is "known only after apply", which makes `terraform import` fail with
# "Invalid for_each argument": import evaluates the whole config graph before any
# apply runs, and unlike apply it has no -target to scope that evaluation, so the
# cert is never planned and its validation options stay unknown (#330). The map
# VALUES still come from the certificate — only the keys must be known here.
resource "aws_route53_record" "cert_validation" {
  for_each = local.manage_route53 ? toset(local.cert_validation_domains) : toset([])

  allow_overwrite = true
  name            = local.cert_validation_options[each.key].name
  records         = [local.cert_validation_options[each.key].record]
  ttl             = 60
  type            = local.cert_validation_options[each.key].type
  zone_id         = aws_route53_zone.main[0].zone_id
}

resource "aws_acm_certificate_validation" "wildcard" {
  count = local.manage_route53 ? 1 : 0

  certificate_arn         = aws_acm_certificate.wildcard.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}
