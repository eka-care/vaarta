# vaarta on ECS Fargate. Two values are required: name and image. Everything else is defaulted.
variable "name" {
  type        = string
  description = "Environment name; prefixes every resource (e.g. acme-ecs)"
}
variable "region" {
  type    = string
  default = "ap-south-1"
}
variable "image" {
  type        = string
  description = "The combined vaarta api + web image, full URI with tag (e.g. <account>.dkr.ecr.<region>.amazonaws.com/vaarta:api-latest)"
}
variable "cpu_architecture" {
  type        = string
  default     = "X86_64"
  description = "Must match the image. vaarta is published for both; X86_64 is the default, ARM64 is cheaper on Fargate (docs/DESIGN-DECISIONS.md, decision 18)"
  validation {
    condition     = contains(["ARM64", "X86_64"], var.cpu_architecture)
    error_message = "cpu_architecture must be ARM64 or X86_64."
  }
}

# ---------------------------------------------------------------- the service
variable "cpu" {
  type        = number
  default     = 1024
  description = "Fargate task CPU units (1024 = 1 vCPU)"
}
variable "memory" {
  type        = number
  default     = 2048
  description = "Fargate task memory in MiB; must be a valid pairing with cpu"
}
variable "desired_count" {
  type        = number
  default     = 1
  description = "Tasks behind the load balancer. Keep 1 while EXECUTION_MODE is inprocess: in-process jobs are lost on restart and not shared across tasks "
}
variable "uvicorn_workers" {
  type    = number
  default = 2
}
variable "app_environment" {
  type        = map(string)
  default     = {}
  description = "Extra or overriding plain environment variables, e.g. the ASR provider and model. Never secrets: these are visible in the task definition"
}
variable "provider_secret_arns" {
  type        = map(string)
  default     = {}
  description = "Env var name => Secrets Manager ARN (optionally with :json-key:: appended) for secret settings: AUTH_PROVIDERS, OPENWEBUI_API_KEY, or provider keys such as ANTHROPIC_API_KEY. Create the secrets yourself so the keys never enter OpenTofu state"
}

# ---------------------------------------------------------------- network
variable "vpc_cidr" {
  type        = string
  default     = "10.70.0.0/16"
  description = "Must not overlap anything you peer with or reach over VPN. Subnets are derived from it"
  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) <= 20
    error_message = "vpc_cidr must be a valid CIDR of /20 or larger."
  }
}
variable "az_count" {
  type    = number
  default = 2
  validation {
    condition     = var.az_count >= 2 && var.az_count <= 4
    error_message = "az_count must be between 2 and 4 (RDS and the load balancer need two zones)."
  }
}
variable "single_nat" {
  type        = bool
  default     = true
  description = "One NAT gateway (cheap start) vs one per AZ"
}

# ---------------------------------------------------------------- edge
variable "domain" {
  type        = string
  default     = ""
  description = "Leave empty to serve HTTP on the load balancer's own hostname. Set it to get a Route 53 zone, an ACM certificate, HTTPS and a DNS record"
}
variable "app_subdomain" {
  type    = string
  default = "scribe"
}
variable "existing_zone_id" {
  type        = string
  default     = ""
  description = "Bring your own Route 53 hosted zone for var.domain; empty = create one"
}
variable "waf" {
  type        = bool
  default     = true
  description = "Regional web ACL with AWS managed rules on the load balancer. false when the client fronts it with their own"
}

# ---------------------------------------------------------------- data
variable "rds_instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "rds_multi_az" {
  type        = bool
  default     = false
  description = "Standby in a second AZ; roughly doubles the RDS cost"
}
variable "rds_allocated_storage" {
  type        = number
  default     = 50
  description = "RDS storage at creation, GB"
}
variable "rds_max_allocated_storage" {
  type        = number
  default     = 500
  description = "RDS storage autoscaling ceiling, GB"
}
variable "log_retention_days" {
  type        = number
  default     = 180
  description = "CloudWatch retention for app and Postgres logs (CERT-In asks for 180 days)"
}

variable "tags" {
  type    = map(string)
  default = {}
}

# ---------------------------------------------------------------- parrotlet-a on EC2 GPU (optional)
# Fargate has no GPU, so the model runs on EC2 instances in the same ECS cluster. vaarta stays on Fargate.
variable "gpu_model" {
  type        = bool
  default     = false
  description = "run parrotlet-a in this cluster on EC2 GPU instances. false = speech goes to the model endpoint in app_environment"
}
variable "gpu_nodes" {
  type        = number
  default     = 1
  description = "GPU instances, and model tasks: one model per instance, fixed, no autoscaling"
}
variable "gpu_instance_type" {
  type        = string
  default     = "g6.2xlarge"
  description = "NVIDIA Ampere or newer: g5.* (A10G), g6.* (L4), g6e.* (L40S). g4dn is rejected"
  validation {
    condition     = can(regex("^(g5|g6|g6e|p4d|p4de|p5|p5e|p5en)\\.", var.gpu_instance_type))
    error_message = "gpu_instance_type must be g5/g6/g6e/p4d/p5 (NVIDIA Ampere or newer); g4dn/T4 does not run the models."
  }
}
variable "gpu_disk_size" {
  type        = number
  default     = 200
  description = "root disk of each GPU instance, GiB; the model image is 24 GB and is pulled onto it"
}
variable "model_image" {
  type        = string
  default     = "ekacare/parrotlet_a:v2.5b"
  description = "the parrotlet-a image; private on Docker Hub, so set model_image_credentials_arn too"
}
variable "model_path" {
  type        = string
  default     = "/model/parrotlet-a"
  description = "--model passed to vllm serve; must match ECHO_DEFAULT_TRANSCRIBER_MODEL"
}
variable "model_image_credentials_arn" {
  type        = string
  default     = ""
  description = "Secrets Manager ARN holding {\"username\":..,\"password\":..} for the private registry. Empty = public image"
}
