terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_region" "current" {}

locals {
  azs           = length(var.availability_zones) > 0 ? var.availability_zones : slice(data.aws_availability_zones.available.names, 0, 3)
  public_cidrs  = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, i)]
  private_cidrs = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, i + 10)]
  name_prefix   = "${var.project_name}-${var.environment}"

  # The VPC has a route to the internet / AWS public APIs — true under either a
  # managed NAT gateway or a fck-nat NAT instance. When false (the NAT-less
  # posture) the private subnets have no egress and the billed interface VPC
  # endpoints below are created to reach the AWS control planes instead.
  private_egress = var.enable_nat_gateway || var.enable_nat_instance

  # How many private route tables to create:
  # NAT disabled     → 1 (no internet route, shared by all private subnets)
  # NAT gw + single  → 1 (shared NAT gateway route)
  # NAT gw + per-AZ  → one per AZ
  # NAT instance     → 1 (single shared instance route; falls through to the
  #                    else branch below since enable_nat_gateway is false)
  private_rt_count = var.enable_nat_gateway ? (var.single_nat_gateway ? 1 : length(local.azs)) : 1
}

# enable_nat_gateway and enable_nat_instance are mutually exclusive egress
# postures — a private route table can carry only one 0.0.0.0/0 default route.
# A plain `variable validation` block cannot cross-reference another variable,
# so the guard lives here as a module-level check.
check "nat_posture_mutually_exclusive" {
  assert {
    condition     = !(var.enable_nat_gateway && var.enable_nat_instance)
    error_message = "enable_nat_gateway and enable_nat_instance are mutually exclusive: choose a managed NAT gateway OR a fck-nat NAT instance, not both."
  }
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.tags, { Name = "${local.name_prefix}-vpc" })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = merge(var.tags, { Name = "${local.name_prefix}-igw" })
}

resource "aws_subnet" "public" {
  count             = length(local.azs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.public_cidrs[count.index]
  availability_zone = local.azs[count.index]

  map_public_ip_on_launch = false

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-public-${local.azs[count.index]}"
    Tier = "public"
  })
}

resource "aws_subnet" "private" {
  count             = length(local.azs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.private_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-private-${local.azs[count.index]}"
    Tier = "private"
  })
}

resource "aws_eip" "nat" {
  count  = var.enable_nat_gateway ? (var.single_nat_gateway ? 1 : length(local.azs)) : 0
  domain = "vpc"
  tags   = merge(var.tags, { Name = "${local.name_prefix}-nat-eip-${count.index}" })
}

resource "aws_nat_gateway" "main" {
  count         = var.enable_nat_gateway ? (var.single_nat_gateway ? 1 : length(local.azs)) : 0
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags       = merge(var.tags, { Name = "${local.name_prefix}-nat-${count.index}" })
  depends_on = [aws_internet_gateway.main]
}

# ---------------------------------------------------------------------------
# fck-nat NAT instance — the cheapest egress posture (~$3-5/month vs ~$33 for a
# managed NAT gateway). Single shared instance, like single_nat_gateway = true.
# Provides full outbound egress (fixing the ADR-0016 in-VPC Lambda self-invoke
# 503) and lets the billed interface VPC endpoints be dropped. All resources are
# count-gated on enable_nat_instance and are absent otherwise.
# ---------------------------------------------------------------------------

# fck-nat AMI. Owner account 568608671756 and the name/architecture filters are
# taken from fck-nat.dev and the RaJiska/fck-nat Terraform module (ec2.tf). The
# arm64 image matches the t4g.nano Graviton default; no region-specific AMI id
# is pinned — most_recent resolves it per region at plan time.
data "aws_ami" "fck_nat" {
  count       = var.enable_nat_instance ? 1 : 0
  most_recent = true
  owners      = ["568608671756"]

  filter {
    name   = "name"
    values = ["fck-nat-al2023-hvm-*"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }
}

resource "aws_security_group" "nat_instance" {
  count       = var.enable_nat_instance ? 1 : 0
  name        = "${local.name_prefix}-nat-instance"
  description = "fck-nat NAT instance: forward egress traffic from within the VPC"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "Traffic from within the VPC to forward to the internet / AWS APIs"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    description = "Forwarded egress to anywhere"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"] #checkov:skip=CKV_AWS_382:NAT instance must forward egress to arbitrary destinations.
  }

  tags = merge(var.tags, { Name = "${local.name_prefix}-nat-instance-sg" })
}

resource "aws_instance" "nat" {
  #checkov:skip=CKV_AWS_126:Detailed monitoring not needed for a dev-tier NAT instance; cost over telemetry.
  #checkov:skip=CKV_AWS_135:t4g.nano is EBS-optimized by default; the attribute is a no-op for this family.
  #checkov:skip=CKV_AWS_88:A NAT instance requires a public IP by design — it is the egress point.
  count                       = var.enable_nat_instance ? 1 : 0
  ami                         = data.aws_ami.fck_nat[0].id
  instance_type               = var.nat_instance_type
  subnet_id                   = aws_subnet.public[0].id
  vpc_security_group_ids      = [aws_security_group.nat_instance[0].id]
  associate_public_ip_address = true
  # NAT forwarding requires the instance to pass traffic not addressed to it.
  source_dest_check = false

  # fck-nat self-configures on boot; no user-data required.

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required" # IMDSv2
  }

  root_block_device {
    encrypted = true
  }

  tags = merge(var.tags, { Name = "${local.name_prefix}-nat-instance" })
}

# EC2 auto-recovery: on a failed system status check, recover the SAME instance
# (and its ENI), so the private route table's network_interface_id route stays
# valid — no failover automation or route rewrite needed for the dev tier.
resource "aws_cloudwatch_metric_alarm" "nat_instance_recover" {
  count               = var.enable_nat_instance ? 1 : 0
  alarm_name          = "${local.name_prefix}-nat-instance-recover"
  alarm_description   = "Recover the fck-nat NAT instance on a system status check failure"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_System"
  statistic           = "Maximum"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  period              = 60
  evaluation_periods  = 2
  alarm_actions       = ["arn:aws:automate:${data.aws_region.current.name}:ec2:recover"]
  dimensions          = { InstanceId = aws_instance.nat[0].id }
  tags                = var.tags
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = merge(var.tags, { Name = "${local.name_prefix}-public-rt" })
}

resource "aws_route_table_association" "public" {
  count          = length(local.azs)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = local.private_rt_count
  vpc_id = aws_vpc.main.id

  # Exactly one 0.0.0.0/0 default route, chosen by egress posture. The two
  # dynamic blocks are mutually exclusive: enable_nat_gateway and
  # enable_nat_instance can never both be true (enforced by the
  # nat_posture_mutually_exclusive check above), so at most one emits a route.
  dynamic "route" {
    for_each = var.enable_nat_gateway ? [true] : []
    content {
      cidr_block     = "0.0.0.0/0"
      nat_gateway_id = aws_nat_gateway.main[count.index].id
    }
  }

  dynamic "route" {
    for_each = var.enable_nat_instance ? [true] : []
    content {
      cidr_block           = "0.0.0.0/0"
      network_interface_id = aws_instance.nat[0].primary_network_interface_id
    }
  }

  tags = merge(var.tags, { Name = "${local.name_prefix}-private-rt-${count.index}" })
}

resource "aws_route_table_association" "private" {
  count     = length(local.azs)
  subnet_id = aws_subnet.private[count.index].id
  route_table_id = var.enable_nat_gateway ? (
    aws_route_table.private[var.single_nat_gateway ? 0 : count.index].id
  ) : aws_route_table.private[0].id
}

# S3 gateway endpoint — free, and always created (independent of NAT posture).
# It keeps bulk S3 object traffic off any NAT path (gateway or instance) and
# lets a NAT-less Lambda still reach S3 without outbound internet. Attaches to
# every private route table, which exists in all postures.
resource "aws_vpc_endpoint" "s3" {
  count        = length(aws_subnet.private) > 0 ? 1 : 0
  vpc_id       = aws_vpc.main.id
  service_name = "com.amazonaws.${data.aws_region.current.name}.s3"

  route_table_ids = [for rt in aws_route_table.private : rt.id]
  tags            = merge(var.tags, { Name = "${local.name_prefix}-s3-endpoint" })
}

# Interface VPC endpoints let the in-VPC Lambda reach AWS service control-plane
# APIs (e.g. Cognito admin operations for user management) without outbound
# internet. Interface endpoints are billed hourly, so they're only created in
# the NAT-less posture (no private egress) where they're actually required.
# Under either NAT posture — managed gateway or fck-nat instance — this traffic
# egresses through the NAT path instead, so these are dropped (local.private_egress).
resource "aws_security_group" "vpc_endpoints" {
  count       = local.private_egress ? 0 : 1
  name        = "${local.name_prefix}-vpce"
  description = "Allow HTTPS from within the VPC to interface VPC endpoints"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS from within the VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    description = "Responses back into the VPC"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = merge(var.tags, { Name = "${local.name_prefix}-vpce-sg" })
}

resource "aws_vpc_endpoint" "cognito_idp" {
  count               = local.private_egress ? 0 : 1
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${data.aws_region.current.name}.cognito-idp"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
  private_dns_enabled = true

  tags = merge(var.tags, { Name = "${local.name_prefix}-cognito-idp-endpoint" })
}

# Secrets Manager interface endpoint — so a no-NAT Lambda can fetch secrets at
# runtime (e.g. the DB credentials secret, or the PR-signer's GitHub App key,
# ADR-0008) instead of relying on values baked into env vars. No-NAT only; with
# any NAT path (gateway or instance) the Lambda reaches the public endpoint
# (issue #147).
resource "aws_vpc_endpoint" "secretsmanager" {
  count               = local.private_egress ? 0 : 1
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${data.aws_region.current.name}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
  private_dns_enabled = true

  tags = merge(var.tags, { Name = "${local.name_prefix}-secretsmanager-endpoint" })
}

# EventBridge interface endpoint — so event publishing (PutEvents) actually
# reaches EventBridge from a no-NAT Lambda instead of hanging. NAT-less only;
# under either NAT posture it egresses through the NAT path (issue #147).
resource "aws_vpc_endpoint" "events" {
  count               = local.private_egress ? 0 : 1
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${data.aws_region.current.name}.events"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
  private_dns_enabled = true

  tags = merge(var.tags, { Name = "${local.name_prefix}-events-endpoint" })
}

# VPC Flow Logs
resource "aws_cloudwatch_log_group" "vpc_flow_logs" {
  #checkov:skip=CKV_AWS_158:VPC flow logs; AWS-service default encryption accepted for this data class.
  #checkov:skip=CKV_AWS_338:Short retention intentional for cost; flow logs are operational telemetry.
  name              = "/biffo/${local.name_prefix}/vpc-flow-logs"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_iam_role" "vpc_flow_logs" {
  name = "${local.name_prefix}-vpc-flow-logs"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "vpc_flow_logs" {
  name = "vpc-flow-logs-policy"
  role = aws_iam_role.vpc_flow_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup", "logs:CreateLogStream",
        "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"
      ]
      Resource = "*"
    }]
  })
}

resource "aws_flow_log" "main" {
  vpc_id          = aws_vpc.main.id
  traffic_type    = "ALL"
  iam_role_arn    = aws_iam_role.vpc_flow_logs.arn
  log_destination = aws_cloudwatch_log_group.vpc_flow_logs.arn
  tags            = var.tags

  # The `log_destination` reference above already makes Terraform destroy this
  # flow log BEFORE its log group (reverse dependency order). This explicit
  # depends_on documents that ordering and preserves it if a future refactor
  # ever stops referencing the group's ARN directly.
  #
  # Ordering alone does NOT fully close the orphan race in #332, though: a live
  # VPC flow log re-materialises its destination CloudWatch group whenever it
  # delivers a log event, and the delivery pipeline keeps writing for a short
  # window AFTER `DeleteFlowLogs` returns. If that straggler delivery lands
  # between Terraform deleting the flow log and deleting the group, the group is
  # recreated after Terraform has already dropped it from state — an orphan the
  # next apply collides with (ResourceAlreadyExistsException). The destroy
  # workflow's post-destroy log-group sweep is the backstop that closes that
  # residual window; do NOT use `skip_destroy`, which would orphan the group by
  # design and make it permanent.
  depends_on = [aws_cloudwatch_log_group.vpc_flow_logs]
}
