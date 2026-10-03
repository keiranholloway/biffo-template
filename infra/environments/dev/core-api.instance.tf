# INSTANCE-OWNED (user-owned infra/ tree). Seeded once; `biffo core upgrade`
# never overwrites it.
#
# Extra environment variables for the template-owned `module "core_api"`
# (core-api.core.tf). Merged LAST, so keys here win over the template's. Example:
#
#   core_api_instance_environment = {
#     BIFFO_DB_SEARCH_PATH = "public,myapp"
#   }
#
# Memory, SnapStart and timeout are tfvars: core_api_memory_size,
# core_api_enable_warm_capacity, core_api_timeout.

locals {
  core_api_instance_environment = {}
}
