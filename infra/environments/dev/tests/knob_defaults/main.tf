# Calls the dev root's real variable declarations (vars/, a symlink, never a
# copy) as a child module and passes NO inputs, so each output is the declared
# default. Because the declarations live one module down, tfvars or test
# variables supplied to the root (an instance's SnapStart, say) cannot reach
# them. Used by core_api_instance_knobs.tftest.hcl. TEMPLATE-OWNED.

module "declared" {
  source = "./vars"
}

output "core_api_memory_size" { value = module.declared.core_api_memory_size }
output "core_api_timeout" { value = module.declared.core_api_timeout }
output "core_api_enable_warm_capacity" { value = module.declared.core_api_enable_warm_capacity }
output "core_api_extra_environment" { value = module.declared.core_api_extra_environment }
