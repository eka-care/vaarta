# Path 4 — the whole thing on AWS, one apply: VPC, EKS cluster, RDS, WAF, the controllers a cluster needs,
# GPU nodes for parrotlet-a, and vaarta's own bucket and IAM role.
#
# It stops there. OpenTofu never installs vaarta or the model: those are two Helm commands, in
# ../../docs/aws-full.md. A failing app release must not be able to roll back a cluster.
#
#   cp terraform.tfvars.example terraform.tfvars && $EDITOR terraform.tfvars
#   tofu init && tofu apply        # about 20 minutes, most of it the cluster and the database
#   tofu output                    # the values that go into your values-aws.yaml

# ---------------------------------------------------------------- 1. the platform: VPC, cluster, RDS, edge
module "platform" {
  source = "../modules/aws-eks"

  name   = var.name
  region = var.region
  domain = var.domain

  kubernetes_version = var.kubernetes_version
  node_instance_type = var.node_instance_type
  node_count         = var.node_count
  node_max           = var.node_max

  vpc_cidr   = var.vpc_cidr
  az_count   = var.az_count
  single_nat = var.single_nat

  rds                = var.rds
  rds_instance_class = var.rds_instance_class
  rds_multi_az       = var.rds_multi_az
  database_name      = var.database_name
  database_username  = var.database_username

  waf                         = var.waf
  cluster_public_access       = var.cluster_public_access
  cluster_public_access_cidrs = var.cluster_public_access_cidrs

  tags = var.tags
}

# ---------------------------------------------------------------- 2. GPU capacity for parrotlet-a
# Skipped entirely with gpu_nodes = 0, and then speech goes to Eka's model endpoint.
module "models" {
  count  = var.gpu_nodes > 0 ? 1 : 0
  source = "../modules/aws-eks-models"

  cluster_name      = module.platform.cluster_name
  region            = var.region
  gpu_nodes         = var.gpu_nodes
  gpu_instance_type = var.gpu_instance_type
  gpu_disk_size     = var.gpu_disk_size
  tags              = var.tags
}

# ---------------------------------------------------------------- 3. vaarta's own AWS resources
# The bucket for recordings and the IAM role the pod assumes to reach it. Nothing else in the platform
# knows what vaarta is.
module "vaarta" {
  source = "../modules/aws-eks-vaarta"

  cluster_name      = module.platform.cluster_name
  region            = var.region
  namespace         = var.namespace
  oidc_provider_arn = module.platform.oidc_provider_arn
  tags              = var.tags
}

# ---------------------------------------------------------------- what to put in values-aws.yaml
output "next_steps" {
  description = "fill these into helm/vaarta/values-aws.yaml, then install (docs/aws-full.md)"
  value = {
    cluster_name = module.platform.cluster_name
    region       = var.region
    namespace    = var.namespace

    # serviceAccount.annotations."eks.amazonaws.com/role-arn"
    role_arn = module.vaarta.role_arn
    # storage.s3.vadedBucket and nonVadedBucket
    bucket = module.vaarta.bucket
    # database.host / name / user
    database_host = module.platform.rds_endpoint
    database_name = module.platform.database_name
    database_user = module.platform.database_username
    # the password to copy into the vaarta-db Secret
    database_secret_name = module.platform.rds_secret_name
    # ingress annotations, when you set a domain
    certificate_arn = module.platform.certificate_arn
    waf_acl_arn     = module.platform.waf_acl_arn
    # 0 = speech from Eka's endpoint; 1 = eka-asr here; 2 = parrotlet-t here too
    gpu_nodes = var.gpu_nodes
  }
}

output "kubeconfig_command" {
  value = module.platform.kubeconfig_command
}
output "zone_name_servers" {
  description = "delegate your domain to these at the registrar, when domain is set"
  value       = module.platform.zone_name_servers
}

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws  = { source = "hashicorp/aws", version = ">= 5.95, < 6.0" }
    helm = { source = "hashicorp/helm", version = "~> 2.17" }
  }
  # State is a local file until you turn this on. It holds the database password, so turn it on before
  # anyone else runs this folder.
  # backend "s3" { bucket = "<state-bucket>", key = "vaarta/<name>.tfstate", region = "ap-south-1", use_lockfile = true }
}

provider "aws" {
  region = var.region
}

# The platform installs its own charts (load balancer controller, Karpenter) and the models module installs
# the NVIDIA device plugin. exec auth, not a static token: a token expires in 15 minutes and the next apply
# would fail.
provider "helm" {
  kubernetes {
    host                   = module.platform.cluster_endpoint
    cluster_ca_certificate = base64decode(module.platform.cluster_certificate_authority_data)
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.platform.cluster_name, "--region", var.region]
    }
  }
}
