provider "aws" {
  region = var.region
  default_tags {
    tags = merge({ Project = "eka-deploy", Environment = var.name }, var.tags)
  }
}

data "aws_availability_zones" "this" { state = "available" }

locals {
  azs = slice(data.aws_availability_zones.this.names, 0, var.az_count)
  # Subnets are derived from var.vpc_cidr, so any /16 works and nothing else has to be retyped.
  # With the default 10.60.0.0/16 this is 10.60.0.0/20, 10.60.16.0/20 … private and 10.60.100.0/24 … public.
  private_subnet_cidrs = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnet_cidrs  = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, 100 + i)]
  create_vpc           = var.existing_vpc_id == ""
  # No domain: no hosted zone, no certificate, no waiting for DNS validation.
  # The app is reached on the load balancer's own hostname over HTTP until a domain is set.
  create_dns      = var.domain != ""
  vpc_id          = local.create_vpc ? module.vpc[0].vpc_id : var.existing_vpc_id
  private_subnets = local.create_vpc ? module.vpc[0].private_subnets : data.aws_subnets.existing_private[0].ids
  public_subnets  = local.create_vpc ? module.vpc[0].public_subnets : data.aws_subnets.existing_public[0].ids
}

# ---------------------------------------------------------------- network
module "vpc" {
  count   = local.create_vpc ? 1 : 0
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.21"

  name            = var.name
  cidr            = var.vpc_cidr
  azs             = local.azs
  private_subnets = local.private_subnet_cidrs
  public_subnets  = local.public_subnet_cidrs

  enable_nat_gateway     = true
  single_nat_gateway     = var.single_nat
  one_nat_gateway_per_az = !var.single_nat
  enable_dns_hostnames   = true

  public_subnet_tags = { "kubernetes.io/role/elb" = 1 }
  # karpenter.sh/discovery is how Karpenter's EC2NodeClass finds where to put nodes. Without it
  # Karpenter launches nothing and explains itself only in its own log.
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = 1, "karpenter.sh/discovery" = var.name }
}

# Bring-your-own VPC: subnets are found by the ELB role tags. Two things a created VPC gets for free have
# to be checked or added here: at least two subnets of each kind, and Karpenter's discovery tag on the
# private ones, without which its EC2NodeClass matches no subnet and it launches nothing.
data "aws_subnets" "existing_private" {
  count = local.create_vpc ? 0 : 1
  filter {
    name   = "vpc-id"
    values = [var.existing_vpc_id]
  }
  tags = { "kubernetes.io/role/internal-elb" = "1" }
  lifecycle {
    postcondition {
      condition     = length(self.ids) >= 2
      error_message = "existing_vpc_id has fewer than two subnets tagged kubernetes.io/role/internal-elb=1; tag the private subnets the cluster should use."
    }
  }
}
data "aws_subnets" "existing_public" {
  count = local.create_vpc ? 0 : 1
  filter {
    name   = "vpc-id"
    values = [var.existing_vpc_id]
  }
  tags = { "kubernetes.io/role/elb" = "1" }
  lifecycle {
    postcondition {
      condition     = length(self.ids) >= 2
      error_message = "existing_vpc_id has fewer than two subnets tagged kubernetes.io/role/elb=1; tag the public subnets the load balancer should use."
    }
  }
}
resource "aws_ec2_tag" "karpenter_discovery" {
  for_each    = local.create_vpc ? toset([]) : toset(data.aws_subnets.existing_private[0].ids)
  resource_id = each.key
  key         = "karpenter.sh/discovery"
  value       = var.name
}

# VPC endpoints keep image pulls and S3 traffic off the NAT gateway
module "vpc_endpoints" {
  count   = local.create_vpc ? 1 : 0
  source  = "terraform-aws-modules/vpc/aws//modules/vpc-endpoints"
  version = "~> 5.21"
  vpc_id  = local.vpc_id
  endpoints = {
    s3 = { service = "s3", service_type = "Gateway", route_table_ids = module.vpc[0].private_route_table_ids }
  }
}

# ---------------------------------------------------------------- cluster
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.37"

  cluster_name    = var.name
  cluster_version = var.kubernetes_version
  vpc_id          = local.vpc_id
  subnet_ids      = local.private_subnets

  cluster_endpoint_public_access           = var.cluster_public_access
  cluster_endpoint_public_access_cidrs     = var.cluster_public_access_cidrs
  enable_cluster_creator_admin_permissions = true
  enable_irsa                              = true

  # The other half of Karpenter's discovery: the security group it attaches to new nodes.
  node_security_group_tags = { "karpenter.sh/discovery" = var.name }

  cluster_addons = {
    coredns    = {}
    kube-proxy = {}
    vpc-cni    = {}
    aws-ebs-csi-driver = {
      service_account_role_arn = module.ebs_csi_irsa.iam_role_arn
      # The add-on's own defaultStorageClass is deliberately left OFF: it sets no encryption, so in an account
      # without EBS encrypt-by-default its volumes are unencrypted. An encrypted gp3 default StorageClass is a
      # documented bootstrap step instead (docs/aws-full.md, step 2b).
    }
    eks-pod-identity-agent = {}
  }

  # One general node group. GPU capacity is not the platform's business: the models bring it with
  # tofu/modules/aws-eks-models, which attaches to any cluster .
  eks_managed_node_groups = {
    general = {
      instance_types = [var.node_instance_type]
      ami_type       = can(regex("^[a-z]+[0-9]+g", split(".", var.node_instance_type)[0])) ? "AL2023_ARM_64_STANDARD" : "AL2023_x86_64_STANDARD" # Graviton families: t4g, m7g, c7gn, r6gd …
      min_size       = 1
      max_size       = var.node_max
      desired_size   = var.node_count
      # disk_size is ignored when the module builds its own launch template (its default), which
      # left nodes on the image's 20 GiB unencrypted root. Set the root volume explicitly instead.
      block_device_mappings = {
        xvda = {
          device_name = "/dev/xvda"
          ebs = {
            volume_size           = var.node_disk_size
            volume_type           = "gp3"
            encrypted             = true
            delete_on_termination = true
          }
        }
      }
    }
  }
}

module "ebs_csi_irsa" {
  source                = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version               = "~> 5.58"
  role_name             = "${var.name}-ebs-csi"
  attach_ebs_csi_policy = true
  oidc_providers        = { main = { provider_arn = module.eks.oidc_provider_arn, namespace_service_accounts = ["kube-system:ebs-csi-controller-sa"] } }
}

# IAM for the AWS Load Balancer Controller; the chart itself is installed in platform-helm.tf
module "alb_irsa" {
  source                                 = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version                                = "~> 5.58"
  role_name                              = "${var.name}-alb-controller"
  attach_load_balancer_controller_policy = true
  oidc_providers                         = { main = { provider_arn = module.eks.oidc_provider_arn, namespace_service_accounts = ["kube-system:aws-load-balancer-controller"] } }
}

# Per-app roles and buckets are not built here. A platform does not know which apps run on it;
# an app that needs cloud resources of its own creates them from its own deployment, reading this module's outputs.

data "aws_caller_identity" "this" {}

# ---------------------------------------------------------------- managed data (scale switches)
resource "random_password" "rds" {
  count   = var.rds ? 1 : 0
  length  = 32
  special = false
}
module "rds" {
  count   = var.rds ? 1 : 0
  source  = "terraform-aws-modules/rds/aws"
  version = "~> 6.12"

  identifier            = "${var.name}-pg"
  engine                = "postgres"
  engine_version        = "16"
  family                = "postgres16"
  instance_class        = var.rds_instance_class
  allocated_storage     = var.rds_allocated_storage
  max_allocated_storage = var.rds_max_allocated_storage
  storage_type          = "gp3" # unset means gp2, a legacy pool that runs out of capacity per AZ (seen 2026-09-17: InsufficientDBInstanceCapacity)
  db_name               = var.database_name
  username              = var.database_username
  password              = random_password.rds[0].result
  # A static password, copied into the cluster once. RDS-managed passwords rotate every 7 days
  # and would break that copy. The password is in OpenTofu state, so state must sit in an encrypted backend.
  manage_master_user_password = false
  port                        = 5432
  multi_az                    = var.rds_multi_az
  storage_encrypted           = true # aws/rds KMS key
  backup_retention_period     = 7
  copy_tags_to_snapshot       = true
  deletion_protection         = true
  skip_final_snapshot         = false # destroy leaves a final-<id> snapshot behind
  create_db_subnet_group      = true
  subnet_ids                  = local.private_subnets
  vpc_security_group_ids      = [aws_security_group.rds[0].id]

  # TLS required on every connection, pinned rather than left to the engine default.
  # The chart sets PGSSLMODE=require to match.
  # log_connections records every login, with whether it used TLS, in the CloudWatch log below.
  parameters = [
    { name = "rds.force_ssl", value = "1" },
    { name = "log_connections", value = "1" },
  ]

  # Postgres logs to CloudWatch, kept 180 days (CERT-In log retention).
  enabled_cloudwatch_logs_exports        = ["postgresql"]
  create_cloudwatch_log_group            = true
  cloudwatch_log_group_retention_in_days = 180
}
resource "aws_security_group" "rds" {
  count  = var.rds ? 1 : 0
  name   = "${var.name}-rds"
  vpc_id = local.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---------------------------------------------------------------- DNS + certificate
resource "aws_route53_zone" "this" {
  count = local.create_dns && var.existing_zone_id == "" ? 1 : 0
  name  = var.domain
}
locals { zone_id = var.existing_zone_id != "" ? var.existing_zone_id : (local.create_dns ? aws_route53_zone.this[0].zone_id : "") }

resource "aws_acm_certificate" "this" {
  count                     = local.create_dns ? 1 : 0
  domain_name               = var.domain
  subject_alternative_names = ["*.${var.domain}"]
  validation_method         = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}
# ACM issues one validation CNAME and asks for it twice, once for the apex and once for the wildcard.
# Keyed by validation option that is two records with one name, and Route 53 rejects the second; keyed by
# record name the key is unknown until the certificate exists and the first plan fails. So: one record,
# keyed by the configured domain (known at plan time), holding the apex's CNAME, which the wildcard shares.
locals {
  acm_validation = local.create_dns ? {
    for o in aws_acm_certificate.this[0].domain_validation_options : o.domain_name => o
  } : {}
}
resource "aws_route53_record" "acm" {
  for_each        = local.create_dns ? toset([var.domain]) : toset([])
  zone_id         = local.zone_id
  name            = local.acm_validation[each.key].resource_record_name
  type            = local.acm_validation[each.key].resource_record_type
  records         = [local.acm_validation[each.key].resource_record_value]
  ttl             = 60
  allow_overwrite = true
}
resource "aws_acm_certificate_validation" "this" {
  count                   = local.create_dns ? 1 : 0
  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for r in aws_route53_record.acm : r.fqdn]
}

# ---------------------------------------------------------------- secrets store (managed data creds for the charts)
resource "aws_secretsmanager_secret" "rds" {
  count = var.rds ? 1 : 0
  name  = "${var.name}/database"
  # Deleted immediately on destroy. The default 30-day recovery window keeps the name reserved, so rebuilding
  # an environment with the same name fails. The password goes with the instance anyway.
  recovery_window_in_days = 0
}
resource "aws_secretsmanager_secret_version" "rds" {
  count         = var.rds ? 1 : 0
  secret_id     = aws_secretsmanager_secret.rds[0].id
  secret_string = jsonencode({ host = module.rds[0].db_instance_address, port = 5432, user = var.database_username, password = random_password.rds[0].result, database = var.database_name })
}
