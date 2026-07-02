variable "project_name" {
  type = string
}

variable "domain" {
  type        = string
  description = "Root domain, e.g. biffo.io — wildcard cert covers *.domain and domain"
}

variable "dns_mode" {
  type        = string
  description = "DNS mode: managed-route53 creates Route 53 DNS records; external requests ACM only."
  default     = "managed-route53"

  validation {
    condition     = contains(["managed-route53", "external"], var.dns_mode)
    error_message = "dns_mode must be either managed-route53 or external for global infrastructure."
  }
}
