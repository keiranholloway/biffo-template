# Plugin object storage — TEMPLATE-OWNED (ADR-0021, biffo-template#1437).
#
# A carve-out inside the otherwise user-owned infra/environments/ tree, the same
# pattern as plugins.core.tf and plugin-host.core.tf. It rides
# `biffo core upgrade`, so every instance gets the grant identically rather than
# depending on someone remembering to hand-edit main.tf.
#
# ## What this grants, and the failure it exists to prevent
#
# A presigned URL carries the SIGNER's permissions. Generating one is a purely
# local operation that never contacts S3, so Core cannot fail fast on a
# permission it does not hold: the endpoint returns 200 with a perfectly-formed
# payload and the upload dies in the browser with AccessDenied.
#
# tabsii-platform has already paid for this exact shape. Its fdd_evidence.tf
# records it: the `agreements/` prefix was missing from the grant, "0005 M2, M3
# and M4 all went green in CI, deployed cleanly, and left a feature in which no
# agreement PDF could be uploaded or served". Every test stubs the S3 client, so
# no lane executed a real PutObject. It was found by a human clicking dev.
#
# `services/api/tests/test_plugin_storage_prefix_grant.py` guards this file
# specifically: it asserts the prefix the Python code builds keys under is
# actually named in the Resource list below. Adding a prefix in code without a
# grant here fails that test rather than shipping green and broken.
resource "aws_iam_role_policy" "core_api_plugin_media" {
  name = "plugin-media-access"
  role = module.core_api.role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "PluginMediaObjects"
        Effect = "Allow"
        # PutObject is not for Core's own use — Core never uploads. It is what
        # the presigned POST inherits, so without it every browser upload is
        # refused. GetObject likewise backs the presigned GET.
        #
        # HeadObject is NOT a distinct S3 IAM action: it is authorised by
        # s3:GetObject. Naming it separately would be a no-op that reads like a
        # grant, so it is deliberately absent — the confirm step's head_object
        # is covered by GetObject above.
        Action = [
          "s3:PutObject",
          "s3:GetObject",
        ]
        # Scoped to the one prefix the capability owns, not the whole bucket.
        # Everything a plugin stores lives under plugins/<plugin>/<tenant>/…,
        # so a wildcard here would grant more than the code can ever use.
        Resource = ["${module.storage.plugin_media_bucket_arn}/plugins/*"]
      },
    ]
  })
}
