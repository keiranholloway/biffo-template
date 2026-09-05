# biffo-template#1901 — the RDS instance (and RDS Proxy, when enabled) must
# accept extra security groups alongside the module's own aws_security_group.db,
# so a caller needing narrow ingress from an SG this module doesn't own can
# attach its own independently-managed SG instead of injecting a rule into
# aws_security_group.db's inline ingress {} block (which Terraform reconciles
# as that SG's complete rule set, silently deleting anything attached from
# outside on the next apply that touches this module).

mock_provider "aws" {
  # aws_db_proxy's auth blocks require a real-shaped ARN for secret_arn, and
  # its role_arn likewise; the default auto-mocked values aren't ARN-shaped
  # and fail those validations.
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:mock-AbCdEf" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
}
mock_provider "random" {}

variables {
  project_name              = "test-proj"
  environment               = "test"
  vpc_id                    = "vpc-0123456789abcdef0"
  private_subnet_ids        = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]
  compute_security_group_id = "sg-0123456789abcdef0"
}

run "default_has_no_additional_security_groups" {
  command = apply

  assert {
    condition     = length(aws_db_instance.main.vpc_security_group_ids) == 1
    error_message = "with no additional_security_group_ids, the RDS instance should carry only the module's own SG"
  }

  assert {
    condition     = contains(aws_db_instance.main.vpc_security_group_ids, aws_security_group.db.id)
    error_message = "the RDS instance's sole SG should be the module's own aws_security_group.db"
  }
}

run "additional_security_group_is_attached_alongside_the_module_sg" {
  command = apply

  variables {
    additional_security_group_ids = ["sg-0aaaaaaaaaaaaaaaa"]
  }

  assert {
    condition     = length(aws_db_instance.main.vpc_security_group_ids) == 2
    error_message = "the RDS instance should carry both the module's own SG and the caller's additional one"
  }

  assert {
    condition     = contains(aws_db_instance.main.vpc_security_group_ids, aws_security_group.db.id)
    error_message = "the module's own SG must still be attached"
  }

  assert {
    condition     = contains(aws_db_instance.main.vpc_security_group_ids, "sg-0aaaaaaaaaaaaaaaa")
    error_message = "the caller's additional SG must be attached"
  }
}

run "additional_security_group_also_reaches_the_rds_proxy_when_enabled" {
  command = apply

  variables {
    enable_rds_proxy              = true
    additional_security_group_ids = ["sg-0aaaaaaaaaaaaaaaa"]
  }

  assert {
    condition     = length(aws_db_proxy.main[0].vpc_security_group_ids) == 2
    error_message = "the RDS Proxy should also carry both the module's own SG and the caller's additional one, since traffic to a proxied instance reaches the proxy's own SG first"
  }

  assert {
    condition     = contains(aws_db_proxy.main[0].vpc_security_group_ids, "sg-0aaaaaaaaaaaaaaaa")
    error_message = "the caller's additional SG must be attached to the RDS Proxy too"
  }
}
