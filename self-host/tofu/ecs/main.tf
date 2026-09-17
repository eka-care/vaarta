# Path 3 — vaarta on ECS, no Kubernetes anywhere, with parrotlet-a on GPU instances beside it.
#
# One apply builds the infrastructure AND runs the app, because ECS has no Helm. That makes this the one path
# where OpenTofu deploys the application itself.
#
# The shape, and why: vaarta runs on Fargate, where you manage no servers. Fargate has no GPU in any region,
# so parrotlet-a cannot run there. With gpu_model = true the same ECS cluster gains an EC2 capacity provider,
# a fixed set of GPU instances that run only the model, and vaarta reaches it by a private DNS name. Those
# instances are yours to patch and pay for; that is the price of a GPU on ECS.
#
#   cp terraform.tfvars.example terraform.tfvars && $EDITOR terraform.tfvars
#   tofu init && tofu apply        # about 15 minutes; the apply waits until the service is healthy
#   then run the migration once: ../../docs/ecs.md

module "vaarta" {
  source = "../modules/aws-ecs-vaarta"

  name   = var.name
  region = var.region
  image  = var.image

  cpu_architecture = var.cpu_architecture
  cpu              = var.cpu
  memory           = var.memory
  desired_count    = var.desired_count

  domain = var.domain
  waf    = var.waf

  vpc_cidr   = var.vpc_cidr
  az_count   = var.az_count
  single_nat = var.single_nat

  rds_instance_class = var.rds_instance_class
  rds_multi_az       = var.rds_multi_az

  # parrotlet-a on EC2 GPU instances in this cluster. false = speech goes to Eka's model endpoint.
  gpu_model                   = var.gpu_model
  gpu_nodes                   = var.gpu_nodes
  gpu_instance_type           = var.gpu_instance_type
  gpu_disk_size               = var.gpu_disk_size
  model_image                 = var.model_image
  model_image_credentials_arn = var.model_image_credentials_arn

  app_environment      = var.app_environment
  provider_secret_arns = var.provider_secret_arns
  tags                 = var.tags
}

output "url" {
  description = "the app's address; SELF_URL is set to it already, unlike on EKS"
  value       = module.vaarta.url
}
output "cluster_name" { value = module.vaarta.cluster_name }
output "region" { value = module.vaarta.region }
output "log_group" { value = module.vaarta.log_group }
output "bucket" { value = module.vaarta.bucket }
output "rds_identifier" { value = module.vaarta.rds_identifier }

# The migration is a one-off task you run by hand, on purpose: a migration that failed inside `apply` would
# leave the service half-released. docs/ecs.md pastes these into `aws ecs run-task`.
output "task_definition_family" { value = module.vaarta.task_definition_family }
output "run_task_network_configuration" { value = module.vaarta.run_task_network_configuration }
output "migrate_overrides" { value = module.vaarta.migrate_overrides }

# Empty unless gpu_model = true.
output "model_url" {
  description = "the in-cluster model endpoint vaarta calls"
  value       = module.vaarta.model_url
}
output "model_log_group" {
  description = "model load and vLLM errors go here; the first start is a 24 GB image pull"
  value       = module.vaarta.model_log_group
}

variable "name" {
  type        = string
  description = "prefixes every resource"
}
variable "region" {
  type    = string
  default = "ap-south-1"
}
variable "image" {
  type        = string
  description = "full image URI with tag, e.g. <account>.dkr.ecr.<region>.amazonaws.com/vaarta:api-latest"
}
variable "cpu_architecture" {
  type        = string
  default     = "X86_64"
  description = "must match the image you pushed. ARM64 is about 20% cheaper on Fargate"
}
variable "cpu" {
  type    = number
  default = 1024
}
variable "memory" {
  type    = number
  default = 2048
}
variable "desired_count" {
  type        = number
  default     = 1
  description = "keep at 1 while the job queue runs in-process "
}
variable "domain" {
  type        = string
  default     = ""
  description = "empty = HTTP on the load balancer hostname. Browsers allow the microphone only on HTTPS or localhost, so a recording demo needs this set"
}
variable "waf" {
  type    = bool
  default = true
}
variable "vpc_cidr" {
  type    = string
  default = "10.70.0.0/16"
}
variable "az_count" {
  type    = number
  default = 2
}
variable "single_nat" {
  type    = bool
  default = true
}
variable "rds_instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "rds_multi_az" {
  type    = bool
  default = false
}

# --- parrotlet-a on EC2 GPU
variable "gpu_model" {
  type        = bool
  default     = false
  description = "run parrotlet-a on GPU instances in this cluster. false = Eka's model endpoint, no GPU cost"
}
variable "gpu_nodes" {
  type    = number
  default = 1
}
variable "gpu_instance_type" {
  type    = string
  default = "g6.2xlarge"
}
variable "gpu_disk_size" {
  type    = number
  default = 200
}
variable "model_image" {
  type    = string
  default = "ekacare/parrotlet_a:v2.5b"
}
variable "model_image_credentials_arn" {
  type        = string
  default     = ""
  description = "Secrets Manager ARN with {\"username\":..,\"password\":..} for Docker Hub; the model image is private"
}

variable "app_environment" {
  type        = map(string)
  default     = {}
  description = "plain settings merged over the defaults, e.g. a hosted speech provider"
}
variable "provider_secret_arns" {
  type        = map(string)
  default     = {}
  description = "env var -> Secrets Manager ARN (with :key::) for provider API keys"
}
variable "tags" {
  type    = map(string)
  default = {}
}

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.95, < 6.0" }
  }
  # State holds the database password. Turn this on before anyone else runs this folder.
  # backend "s3" { bucket = "<state-bucket>", key = "vaarta/<name>-ecs.tfstate", region = "ap-south-1", use_lockfile = true }
}

provider "aws" {
  region = var.region
}
