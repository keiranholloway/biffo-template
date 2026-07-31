# Lambda deployment-artifacts bucket (#994) — template-owned, like
# plugins.core.tf / plugin-host.core.tf / pr-signer.core.tf.
#
# The output lives HERE rather than in main.tf because main.tf is user-owned:
# infra/environments/ belongs to the instance, so an output added there would
# never reach an existing instance through `biffo core upgrade` and the
# ARTIFACTS_BUCKET_NAME variable would silently never be set. That is the same
# distribution gap #243/#548/#568 were each filed for, and it is invisible until
# an instance quietly keeps deploying the slow way.
#
# It depends only on the template-seeded shape every instance has —
# `module "storage"`, wired in main.tf at `biffo init` — the same assumption
# pr-signer.core.tf already makes about module.core_api.
output "artifacts_bucket_name" {
  description = "Private bucket holding Lambda deployment packages for S3-based update-function-code."
  value       = module.storage.artifacts_bucket_name
}
