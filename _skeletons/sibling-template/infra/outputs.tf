output "api_url" {
  description = "This sibling's own API Gateway endpoint — set as NEXT_PUBLIC_API_URL in the frontend build."
  value       = module.api_gateway.api_endpoint
}

output "site_bucket_name" {
  value = module.storage.site_bucket_name
}

output "site_bucket_regional_domain" {
  description = "Consumed by the core project's registration PR — written into its siblings.auto.tfvars.json as this sibling's bucket_regional_domain (see modules/cloud/aws/cdn's sibling_origins in the core repo)."
  value       = module.storage.site_bucket_regional_domain
}

output "lambda_function_name" {
  value = module.api.function_name
}
