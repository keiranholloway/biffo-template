# Egress posture: fck-nat NAT instance (item A of #511).
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

run "nat_instance_posture" {
  command = apply

  variables {
    enable_nat_gateway  = false
    enable_nat_instance = true
  }

  assert {
    condition     = length(aws_instance.nat) == 1
    error_message = "expected a single fck-nat NAT instance"
  }

  assert {
    condition     = length(aws_security_group.nat_instance) == 1
    error_message = "expected the NAT instance security group"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.nat_instance_recover) == 1
    error_message = "expected the EC2 auto-recovery alarm for the NAT instance"
  }

  assert {
    condition     = aws_instance.nat[0].source_dest_check == false
    error_message = "NAT instance must have source_dest_check disabled to forward traffic"
  }

  assert {
    condition     = aws_instance.nat[0].subnet_id == aws_subnet.public[0].id
    error_message = "NAT instance must live in the first public subnet"
  }

  # Interface endpoints dropped; free S3 gateway endpoint still present.
  assert {
    condition     = length(aws_vpc_endpoint.cognito_idp) == 0 && length(aws_vpc_endpoint.secretsmanager) == 0 && length(aws_vpc_endpoint.events) == 0
    error_message = "billed interface endpoints must be absent under the NAT instance posture"
  }

  assert {
    condition     = length(aws_vpc_endpoint.s3) == 1
    error_message = "the free S3 gateway endpoint should always be created"
  }

  assert {
    condition     = length(aws_nat_gateway.main) == 0
    error_message = "no managed NAT gateway under the NAT instance posture"
  }

  # Default route via the NAT instance's primary ENI.
  assert {
    condition     = anytrue([for r in aws_route_table.private[0].route : r.network_interface_id != ""])
    error_message = "private route table should route 0.0.0.0/0 via the NAT instance ENI"
  }

  # Every private subnet associates with the single RT carrying the instance route.
  assert {
    condition     = alltrue([for a in aws_route_table_association.private : a.route_table_id == aws_route_table.private[0].id])
    error_message = "all private subnets must associate with the single instance-route RT"
  }
}
