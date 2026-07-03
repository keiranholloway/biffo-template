locals {
  name_prefix = "${var.project_name}-${var.environment}"
}

module "storage" {
  source = "../modules/cloud/aws/storage"

  project_name = var.project_name
  environment  = var.environment
  tags         = var.tags
}

# Fetched at apply time and baked into the Lambda's own env vars, so JWT
# verification never needs an outbound call to Cognito at request time
# (matches the core project's no-NAT dev environment pattern). Key rotation
# requires a `terraform apply` to refresh this.
data "http" "cognito_jwks" {
  url = "https://cognito-idp.${var.aws_region}.amazonaws.com/${var.core_cognito_user_pool_id}/.well-known/jwks.json"
}

module "api" {
  source = "../modules/cloud/aws/compute"

  project_name  = var.project_name
  environment   = var.environment
  function_name = "api"
  handler       = "src.api.main.lambda_handler"

  environment_variables = {
    SIBLING_ENVIRONMENT          = var.environment
    SIBLING_CORE_API_URL         = var.core_api_url
    SIBLING_COGNITO_JWKS_JSON    = data.http.cognito_jwks.response_body
    SIBLING_COGNITO_USER_POOL_ID = var.core_cognito_user_pool_id
    SIBLING_COGNITO_CLIENT_ID    = var.core_cognito_client_id
    SIBLING_COGNITO_REGION       = var.aws_region
    SIBLING_CORS_ORIGINS         = jsonencode(var.cors_origins)
  }

  tags = var.tags
}

module "api_gateway" {
  source = "../modules/cloud/aws/api-gateway"

  project_name         = var.project_name
  environment          = var.environment
  lambda_function_arn  = module.api.function_arn
  lambda_function_name = module.api.function_name
  cognito_user_pool_id = var.core_cognito_user_pool_id
  cognito_client_id    = var.core_cognito_client_id
  aws_region           = var.aws_region
  cors_origins         = var.cors_origins
  tags                 = var.tags
}

# See variables.tf's parent_cloudfront_distribution_arn comment: this is
# deliberately skipped (count = 0) until the core project's registration PR
# has merged and redeployed with this sibling's origin — there's no
# distribution ARN to trust before then. Two-phase apply, not a bug.
resource "aws_s3_bucket_policy" "site" {
  count  = var.parent_cloudfront_distribution_arn != "" ? 1 : 0
  bucket = module.storage.site_bucket_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCoreCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${module.storage.site_bucket_arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = var.parent_cloudfront_distribution_arn
        }
      }
    }]
  })
}
