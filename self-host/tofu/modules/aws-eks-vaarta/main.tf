locals {
  create_bucket = var.existing_bucket == ""
  bucket        = local.create_bucket ? one(aws_s3_bucket.vaarta[*].id) : var.existing_bucket
  bucket_arn    = local.create_bucket ? one(aws_s3_bucket.vaarta[*].arn) : one(data.aws_s3_bucket.existing[*].arn)
  # The cluster's OIDC provider, looked up from the cluster itself unless handed in. This is what makes the
  # module work on a cluster the kit did not build: the cluster's name is the only fact it needs.
  # one() rather than [0]: a conditional still type-checks the branch it does not take.
  oidc_provider_arn = var.oidc_provider_arn != "" ? var.oidc_provider_arn : one(data.aws_iam_openid_connect_provider.cluster[*].arn)
}

data "aws_caller_identity" "this" {}

data "aws_eks_cluster" "this" {
  count = var.oidc_provider_arn == "" ? 1 : 0
  name  = var.cluster_name
}
data "aws_iam_openid_connect_provider" "cluster" {
  count = var.oidc_provider_arn == "" ? 1 : 0
  url   = data.aws_eks_cluster.this[0].identity[0].oidc[0].issuer
}

# ---------------------------------------------------------------- recordings
resource "aws_s3_bucket" "vaarta" {
  count         = local.create_bucket ? 1 : 0
  bucket        = "${var.cluster_name}-vaarta-${data.aws_caller_identity.this.account_id}"
  force_destroy = false
  tags          = var.tags
}
resource "aws_s3_bucket_versioning" "vaarta" {
  count  = local.create_bucket ? 1 : 0
  bucket = aws_s3_bucket.vaarta[0].id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "vaarta" {
  count  = local.create_bucket ? 1 : 0
  bucket = aws_s3_bucket.vaarta[0].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "aws:kms" }
  }
}
resource "aws_s3_bucket_public_access_block" "vaarta" {
  count                   = local.create_bucket ? 1 : 0
  bucket                  = aws_s3_bucket.vaarta[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
data "aws_s3_bucket" "existing" {
  count  = local.create_bucket ? 0 : 1
  bucket = var.existing_bucket
}

# ---------------------------------------------------------------- access, without static keys
resource "aws_iam_policy" "vaarta_s3" {
  name = "${var.cluster_name}-vaarta-s3"
  tags = var.tags
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = local.bucket_arn },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${local.bucket_arn}/*" }
    ]
  })
}

module "vaarta_irsa" {
  source           = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version          = "~> 5.58"
  role_name        = "${var.cluster_name}-vaarta"
  role_policy_arns = { s3 = aws_iam_policy.vaarta_s3.arn }
  oidc_providers   = { main = { provider_arn = local.oidc_provider_arn, namespace_service_accounts = ["${var.namespace}:${var.service_account}"] } }
  tags             = var.tags
}
