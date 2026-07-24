# Egress posture: NAT-less (billed interface VPC endpoints, no private egress).
# See nat_gateway.tftest.hcl for why each posture is a separate file and how the
# mock_provider setup works.

mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:mock" }
  }
}

variables {
  project_name       = "biffo"
  environment        = "test"
  vpc_cidr           = "10.0.0.0/16"
  availability_zones = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

run "nat_less_posture" {
  command = apply

  variables {
    enable_nat_gateway = false
  }

  assert {
    condition     = length(aws_nat_gateway.main) == 0
    error_message = "no NAT gateway under the NAT-less posture"
  }

  assert {
    condition     = length(aws_instance.nat) == 0
    error_message = "no NAT instance under the NAT-less posture"
  }

  assert {
    condition     = length(aws_vpc_endpoint.cognito_idp) == 1 && length(aws_vpc_endpoint.secretsmanager) == 1 && length(aws_vpc_endpoint.events) == 1
    error_message = "the three interface endpoints must be created in the NAT-less posture"
  }

  assert {
    condition     = length(aws_vpc_endpoint.s3) == 1
    error_message = "the free S3 gateway endpoint should always be created"
  }

  # No egress default route: assert on the absence of a real 0.0.0.0/0 route
  # (mock_provider may synthesize a placeholder element in the computed set).
  assert {
    condition     = length([for r in aws_route_table.private[0].route : r if r.cidr_block == "0.0.0.0/0"]) == 0
    error_message = "NAT-less private route table should have no 0.0.0.0/0 route"
  }
}
