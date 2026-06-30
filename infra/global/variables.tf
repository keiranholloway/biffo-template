variable "project_name" {
  type = string
}

variable "domain" {
  type        = string
  description = "Root domain, e.g. biffo.io — wildcard cert covers *.domain and domain"
}
