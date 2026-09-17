# Path 5 — vaarta and the model onto an EKS cluster you already have. This creates only what is specific to
# vaarta and what Helm cannot create for itself:
#
#   - an S3 bucket for recordings, and an IAM role the pod assumes to reach it (no access keys)
#   - GPU nodes and the NVIDIA device plugin, when you want parrotlet-a in the cluster
#
# It touches nothing else about your cluster: no VPC, no node groups of yours, no controllers, no changes to
# your authentication configuration. It needs two facts, the cluster's name and region, and reads the rest
# from the cluster itself.
#
#   cp terraform.tfvars.example terraform.tfvars && $EDITOR terraform.tfvars
#   tofu init && tofu apply && tofu output
#
# Your cluster must already have an ingress controller that turns an Ingress into a load balancer. On EKS
# that is the AWS Load Balancer Controller. ../../docs/aws-existing.md says how to check.

module "vaarta" {
  source = "../modules/aws-eks-vaarta"

  cluster_name    = var.cluster_name
  region          = var.region
  namespace       = var.namespace
  existing_bucket = var.existing_bucket
  tags            = var.tags
}

# Skipped with gpu_nodes = 0, and then speech goes to Eka's model endpoint or anywhere else you point it.
module "models" {
  count  = var.gpu_nodes > 0 ? 1 : 0
  source = "../modules/aws-eks-models"

  cluster_name          = var.cluster_name
  region                = var.region
  gpu_nodes             = var.gpu_nodes
  gpu_instance_type     = var.gpu_instance_type
  gpu_disk_size         = var.gpu_disk_size
  subnet_ids            = var.subnet_ids
  install_device_plugin = var.install_device_plugin
  tags                  = var.tags
}

output "next_steps" {
  description = "fill these into helm/vaarta/values-aws.yaml, then install (docs/aws-existing.md)"
  value = {
    # serviceAccount.annotations."eks.amazonaws.com/role-arn"
    role_arn = module.vaarta.role_arn
    # storage.s3.vadedBucket and nonVadedBucket
    bucket    = module.vaarta.bucket
    region    = var.region
    namespace = var.namespace
    gpu_nodes = var.gpu_nodes
  }
}

variable "cluster_name" {
  type        = string
  description = "the EKS cluster to install into. Its version, subnets and OIDC provider are read from it"
}
variable "region" { type = string }
variable "namespace" {
  type        = string
  default     = "eka-care"
  description = "the IAM role trusts exactly <namespace>:vaarta, so this must match where you install the chart"
}
variable "existing_bucket" {
  type        = string
  default     = ""
  description = "a bucket you already have. Empty = one is created for you"
}
variable "gpu_nodes" {
  type        = number
  default     = 0
  description = "0 = no GPU here. 1 = parrotlet-a (speech). 2 = parrotlet-t (notes) as well"
}
variable "gpu_instance_type" {
  type    = string
  default = "g6.2xlarge"
}
variable "gpu_disk_size" {
  type    = number
  default = 200
}
variable "subnet_ids" {
  type        = list(string)
  default     = []
  description = "private subnets for the GPU nodes. Empty = your cluster's own subnets that do not assign public IPs"
}
variable "install_device_plugin" {
  type        = bool
  default     = true
  description = "false when your cluster already runs NVIDIA's device plugin (EKS Auto Mode ships it)"
}
variable "tags" {
  type    = map(string)
  default = {}
}

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws  = { source = "hashicorp/aws", version = ">= 5.95, < 6.0" }
    helm = { source = "hashicorp/helm", version = "~> 2.17" }
  }
}

provider "aws" {
  region = var.region
}

# Only used to install the NVIDIA device plugin, and only when gpu_nodes > 0.
data "aws_eks_cluster" "this" {
  name = var.cluster_name
}
provider "helm" {
  kubernetes {
    host                   = data.aws_eks_cluster.this.endpoint
    cluster_ca_certificate = base64decode(data.aws_eks_cluster.this.certificate_authority[0].data)
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", var.cluster_name, "--region", var.region]
    }
  }
}
