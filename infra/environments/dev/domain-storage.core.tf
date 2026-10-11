# Domain object storage — TEMPLATE-OWNED (biffo-platform#337).
#
# Grants the Core API role s3:PutObject, s3:GetObject and s3:DeleteObject on the
# `domains/*` prefix of the plugin media bucket, for user-owned product domains
# (api.domain_storage). The plugin host role is deliberately NOT granted this
# prefix: plugins never touch domain files.
#
# Separate from plugin-storage.core.tf because the prefix-grant guard requires
# every policy in that file to name `plugins/*`.
# Guard: services/api/tests/test_domain_storage_prefix_grant.py

resource "aws_iam_role_policy" "core_api_domain_storage" {
  name = "domain-storage-access"
  role = module.core_api.role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DomainStorageObjects"
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
        ]
        Resource = ["${module.storage.plugin_media_bucket_arn}/domains/*"]
      },
    ]
  })
}
