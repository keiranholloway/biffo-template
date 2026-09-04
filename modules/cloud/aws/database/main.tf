terraform {
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.0" }
  }
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"
  db_name     = replace(var.project_name, "-", "_")
  db_user     = "biffo_${replace(var.environment, "-", "_")}"
  db_address  = var.enable_rds_proxy ? aws_db_proxy.main[0].endpoint : aws_db_instance.main.address
}

resource "random_password" "db_password" {
  # Deliberately excludes '%' (and '/', '@', which were never in the set):
  # this is the RDS master password, interpolated into the asyncpg URL below
  # (db_url output) and into services/api/src/api/database.py's
  # _url_from_secret. A literal '%' is ambiguous with percent-encoding when
  # that URL is parsed back apart, corrupting the password SQLAlchemy's
  # make_url hands to asyncpg — every unauthenticated route depends on this
  # connection, so a corrupted password 500s all of them (#1888). Same
  # defect, same fix as random_password.app_password below (#187 upstream).
  length           = 32
  special          = true
  override_special = "!#$&*()-_=+[]{}<>:?"
}

# ---------------------------------------------------------------------------
# Least-privilege application role (#253)
#
# db_user above is the RDS master: table owner, rds_superuser, BYPASSRLS. It
# stays the credential for migrations, biffo:db-init and biffo:ddl-import,
# which create and alter objects. var.app_db_user is the non-owner role the
# Core API's *request path* connects as instead, so an injection or a
# compromised dependency on a query path cannot drop or read beyond the rows
# the API already serves.
#
# Terraform only mints the credential; the Postgres role itself is created and
# granted by biffo:db-init (services/api/src/api/db_app_role.py), because role
# creation is in-database work Terraform has no connection to perform.
# ---------------------------------------------------------------------------
resource "random_password" "app_password" {
  # Deliberately excludes '%' (and '/', '@', which were never in the set):
  # this password is interpolated into the asyncpg URL below, and '%' makes a
  # literal password ambiguous with percent-encoding when the URL is parsed
  # back apart to bootstrap the role. Length 40 more than compensates for the
  # two dropped symbols.
  length           = 40
  special          = true
  override_special = "!#$&*()-_=+[]{}<>:?"
}

resource "aws_secretsmanager_secret" "app_credentials" {
  name                    = "/${var.project_name}/${var.environment}/db/app-credentials"
  description             = "Least-privilege PostgreSQL application role for ${local.name_prefix} (#253)"
  recovery_window_in_days = var.environment == "prod" ? 30 : 0
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "app_credentials" {
  secret_id = aws_secretsmanager_secret.app_credentials.id
  # Same key shape as db_credentials — services/api/src/api/database.py reads
  # both through one _url_from_secret().
  secret_string = jsonencode({
    username = var.app_db_user
    password = random_password.app_password.result
    dbname   = local.db_name
    engine   = "postgres"
    port     = 5432
    host     = aws_db_instance.main.address
  })
}

resource "aws_secretsmanager_secret" "db_credentials" {
  name                    = "/${var.project_name}/${var.environment}/db/credentials"
  description             = "PostgreSQL credentials for ${local.name_prefix}"
  recovery_window_in_days = var.environment == "prod" ? 30 : 0
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "db_credentials" {
  secret_id = aws_secretsmanager_secret.db_credentials.id
  secret_string = jsonencode({
    username = local.db_user
    password = random_password.db_password.result
    dbname   = local.db_name
    engine   = "postgres"
    port     = 5432
    host     = aws_db_instance.main.address
  })
}

# Security group — only the compute SG (Core API Lambda) can connect (ADR-0002)
resource "aws_security_group" "db" {
  name        = "${local.name_prefix}-db-sg"
  description = "RDS PostgreSQL - inbound restricted to Core API Lambda only"
  vpc_id      = var.vpc_id

  ingress {
    description     = "PostgreSQL from Core API Lambda only"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.compute_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${local.name_prefix}-db-sg" })
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnet-group"
  subnet_ids = var.private_subnet_ids
  tags       = var.tags
}

resource "aws_db_parameter_group" "main" {
  name   = "${local.name_prefix}-pg16"
  family = "postgres${var.postgres_version}"

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  tags = var.tags
}

# Pre-created so Terraform owns these instead of RDS auto-creating untracked,
# never-expiring log groups the destroy workflow doesn't know to clean up.
resource "aws_cloudwatch_log_group" "postgresql" {
  #checkov:skip=CKV_AWS_158:RDS-managed engine logs; AWS-service default encryption accepted for this data class.
  #checkov:skip=CKV_AWS_338:Short retention is intentional for cost; RDS logs are operational, not audit records.
  name              = "/aws/rds/instance/${local.name_prefix}-postgres/postgresql"
  retention_in_days = var.environment == "prod" ? 90 : 14
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "upgrade" {
  #checkov:skip=CKV_AWS_158:RDS-managed engine logs; AWS-service default encryption accepted for this data class.
  #checkov:skip=CKV_AWS_338:Short retention is intentional for cost; RDS logs are operational, not audit records.
  name              = "/aws/rds/instance/${local.name_prefix}-postgres/upgrade"
  retention_in_days = var.environment == "prod" ? 90 : 14
  tags              = var.tags
}

resource "aws_db_instance" "main" {
  identifier = "${local.name_prefix}-postgres"

  engine            = "postgres"
  engine_version    = var.postgres_version
  instance_class    = var.instance_class
  allocated_storage = var.allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = local.db_name
  username = local.db_user
  password = random_password.db_password.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.main.name

  multi_az            = var.multi_az
  publicly_accessible = false
  deletion_protection = var.deletion_protection
  # Always take one. A final snapshot costs pennies and converts "the database
  # is gone" into "the database is recoverable" — the difference that matters
  # when a replacement lands unattended (#387).
  skip_final_snapshot     = var.skip_final_snapshot
  backup_retention_period = var.backup_retention_days
  backup_window           = "03:00-04:00"
  maintenance_window      = "Mon:04:00-Mon:05:00"

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  iam_database_authentication_enabled = var.enable_iam_database_authentication

  depends_on = [aws_cloudwatch_log_group.postgresql, aws_cloudwatch_log_group.upgrade]

  tags = merge(var.tags, { Name = "${local.name_prefix}-postgres" })
}

# RDS Proxy — optional; recommended for prod to handle Lambda connection churn.
# Enable with: enable_rds_proxy = true
resource "aws_iam_role" "rds_proxy" {
  count = var.enable_rds_proxy ? 1 : 0
  name  = "${local.name_prefix}-rds-proxy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "rds_proxy_secrets" {
  count = var.enable_rds_proxy ? 1 : 0
  name  = "read-db-secret"
  role  = aws_iam_role.rds_proxy[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue"]
      Resource = [
        aws_secretsmanager_secret.db_credentials.arn,
        # The proxy authenticates each client credential it accepts against a
        # secret. Without this the app role's connections are rejected at the
        # proxy, before Postgres ever sees them (#253).
        aws_secretsmanager_secret.app_credentials.arn,
      ]
    }]
  })
}

resource "aws_db_proxy" "main" {
  count                  = var.enable_rds_proxy ? 1 : 0
  name                   = "${local.name_prefix}-proxy"
  debug_logging          = var.environment == "dev"
  engine_family          = "POSTGRESQL"
  idle_client_timeout    = 1800
  require_tls            = true
  role_arn               = aws_iam_role.rds_proxy[0].arn
  vpc_security_group_ids = [aws_security_group.db.id]
  vpc_subnet_ids         = var.private_subnet_ids

  # One auth block per credential the proxy will accept. The master is what
  # migrations/db-init present; the app role is what the request path presents
  # (#253) — omitting the second block makes every API request fail
  # authentication at the proxy on any proxy-enabled environment.
  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_secretsmanager_secret.db_credentials.arn
  }

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_secretsmanager_secret.app_credentials.arn
  }

  tags = var.tags
}

resource "aws_db_proxy_default_target_group" "main" {
  count         = var.enable_rds_proxy ? 1 : 0
  db_proxy_name = aws_db_proxy.main[0].name

  connection_pool_config {
    max_connections_percent = 90
  }
}

resource "aws_db_proxy_target" "main" {
  count                  = var.enable_rds_proxy ? 1 : 0
  db_instance_identifier = aws_db_instance.main.identifier
  db_proxy_name          = aws_db_proxy.main[0].name
  target_group_name      = aws_db_proxy_default_target_group.main[0].name
}
