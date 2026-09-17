# ---------------------------------------------------------------- recordings: S3
resource "aws_s3_bucket" "vaarta" {
  bucket        = "${var.name}-vaarta-${data.aws_caller_identity.this.account_id}"
  force_destroy = false
}
resource "aws_s3_bucket_versioning" "vaarta" {
  bucket = aws_s3_bucket.vaarta.id
  versioning_configuration {
    status = "Enabled"
  }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "vaarta" {
  bucket = aws_s3_bucket.vaarta.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
  }
}
resource "aws_s3_bucket_public_access_block" "vaarta" {
  bucket                  = aws_s3_bucket.vaarta.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_policy" "vaarta_tls_only" {
  bucket     = aws_s3_bucket.vaarta.id
  depends_on = [aws_s3_bucket_public_access_block.vaarta]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyPlainHTTP"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.vaarta.arn, "${aws_s3_bucket.vaarta.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# ---------------------------------------------------------------- database: RDS for PostgreSQL 16
resource "random_password" "db" {
  length  = 32
  special = false
}
module "rds" {
  source  = "terraform-aws-modules/rds/aws"
  version = "~> 6.12"

  identifier     = "${var.name}-pg"
  engine         = "postgres"
  engine_version = "16"
  family         = "postgres16"
  instance_class = var.rds_instance_class

  allocated_storage     = var.rds_allocated_storage
  max_allocated_storage = var.rds_max_allocated_storage
  storage_type          = "gp3" # unset means gp2, a legacy pool that runs out of capacity per AZ (seen 2026-09-17: InsufficientDBInstanceCapacity)
  db_name               = "scribe"
  username              = "scribe"
  # A static password in Secrets Manager, read by ECS at task start. It is in OpenTofu state,
  # so state must sit in an encrypted backend.
  password                    = random_password.db.result
  manage_master_user_password = false
  port                        = 5432

  multi_az                = var.rds_multi_az
  storage_encrypted       = true # aws/rds KMS key
  backup_retention_period = 7
  copy_tags_to_snapshot   = true
  deletion_protection     = true
  skip_final_snapshot     = false # destroy leaves a final-<id> snapshot behind

  create_db_subnet_group = true
  subnet_ids             = module.vpc.private_subnets
  vpc_security_group_ids = [aws_security_group.rds.id]

  # TLS required on every connection; every login is logged, with whether it used TLS.
  parameters = [
    { name = "rds.force_ssl", value = "1" },
    { name = "log_connections", value = "1" },
  ]
  enabled_cloudwatch_logs_exports        = ["postgresql"]
  create_cloudwatch_log_group            = true
  cloudwatch_log_group_retention_in_days = var.log_retention_days
}

# ---------------------------------------------------------------- secrets ECS injects at task start
resource "aws_secretsmanager_secret" "database" {
  name = "${var.name}/vaarta/database"
  # Deleted immediately on destroy; the 30-day default keeps the name reserved and blocks a rebuild.
  recovery_window_in_days = 0
}
resource "aws_secretsmanager_secret_version" "database" {
  secret_id = aws_secretsmanager_secret.database.id
  secret_string = jsonencode({
    host     = module.rds.db_instance_address
    port     = 5432
    user     = "scribe"
    database = "scribe"
    password = random_password.db.result
    # ECS cannot compose one variable from another, so the full URL is stored ready-made.
    url = "postgresql://scribe:${random_password.db.result}@${module.rds.db_instance_address}:5432/scribe"
  })
}

resource "random_password" "auth_jwt" {
  length  = 64
  special = false
}
resource "random_password" "upload_signing" {
  length  = 64
  special = false
}
resource "aws_secretsmanager_secret" "app" {
  name                    = "${var.name}/vaarta/app"
  recovery_window_in_days = 0
}
resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    AUTH_JWT_SECRET           = random_password.auth_jwt.result
    UPLOAD_URL_SIGNING_SECRET = random_password.upload_signing.result
  })
}
