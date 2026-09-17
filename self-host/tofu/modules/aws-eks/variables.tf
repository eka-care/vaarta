# The whole surface a person fills. Everything else is derived.
variable "name" {
  type        = string
  description = "Environment name; prefixes every resource (e.g. acme-prod)"
}
variable "region" {
  type    = string
  default = "ap-south-1"
}
variable "cluster_public_access" {
  type        = bool
  default     = true
  description = "public Kubernetes API endpoint. True is convenient and is how kubectl reaches the cluster from a laptop; set false once a bastion, VPN or CI runner inside the VPC is available, and lock cluster_public_access_cidrs down before then"
}
variable "cluster_public_access_cidrs" {
  type        = list(string)
  default     = ["0.0.0.0/0"]
  description = "who may reach the public API endpoint. Narrow this to office and VPN ranges as soon as they are known"
}
variable "domain" {
  type        = string
  default     = ""
  description = "Public DNS zone the app answers on (e.g. acme.example.com). Leave empty to skip DNS entirely: no hosted zone, no certificate, no waiting for validation — the app is reached on the load balancer's own hostname over HTTP. Set it later and re-apply"
}

variable "node_instance_type" {
  type        = string
  default     = "t3.medium"
  description = "amd64 by default, because the image is multi-arch and amd64 is what most people can debug. A Graviton type (t4g, m7g, c7g …) is cheaper and also works: the AMI follows this value automatically"
}
variable "node_count" {
  type        = number
  default     = 2
  description = "Desired size of the general node group (cheap start: 2)"
}
variable "node_max" {
  type    = number
  default = 6
}

variable "rds" {
  type        = bool
  default     = true
  description = "RDS for PostgreSQL 16 (the AWS default). false = no managed database; an app brings its own"
}
variable "rds_instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "rds_multi_az" {
  type        = bool
  default     = false
  description = "Standby in a second AZ; roughly doubles the RDS cost"
}

variable "existing_vpc_id" {
  type        = string
  default     = ""
  description = "Bring your own VPC (must have tagged private/public subnets); empty = create"
}
variable "existing_zone_id" {
  type        = string
  default     = ""
  description = "Bring your own Route 53 hosted zone; empty = create for var.domain"
}
variable "single_nat" {
  type        = bool
  default     = true
  description = "One NAT gateway (cheap start) vs one per AZ (scale)"
}
variable "kubernetes_version" {
  type    = string
  default = "1.36"
}
variable "tags" {
  type    = map(string)
  default = {}
}

# ---------------------------------------------------------------- platform charts
# Installed by this module because a cluster without them cannot route traffic or grow.
# App charts are never installed here (decision 10).
variable "karpenter" {
  type        = bool
  default     = true
  description = "Karpenter, for nodes beyond the fixed group. It never provisions GPU instances: those come from tofu/modules/aws-eks-models"
}
variable "karpenter_cpu_limit" {
  type        = number
  default     = 100
  description = "ceiling in vCPU for everything Karpenter may create"
}
variable "karpenter_version" {
  type    = string
  default = "1.6.3"
}
variable "alb_controller_version" {
  type    = string
  default = "3.5.0"
}
# ---------------------------------------------------------------- the database this platform offers
# One Postgres server any app on the cluster can use. The names are configuration, not app knowledge:
# An app that needs a particular name asks for it in its own deployment.
variable "database_name" {
  type        = string
  default     = "app"
  description = "database created on the RDS instance"
}
variable "database_username" {
  type        = string
  default     = "app"
  description = "master user of that database; its password goes to Secrets Manager"
}

variable "vpc_cidr" {
  type        = string
  default     = "10.60.0.0/16"
  description = "address space for a VPC this module creates. Pick one that does not overlap anything you peer with or connect over VPN. Ignored when existing_vpc_id is set"
  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) <= 20
    error_message = "vpc_cidr must be valid CIDR and /20 or larger to fit the derived subnets."
  }
}
variable "az_count" {
  type        = number
  default     = 2
  description = "availability zones to spread across. 2 on the cheap start, 3 for production"
  validation {
    condition     = var.az_count >= 2 && var.az_count <= 4
    error_message = "az_count must be between 2 and 4."
  }
}

variable "waf" {
  type        = bool
  default     = true
  description = "regional WAF web ACL with AWS managed rules (common, known bad inputs, IP reputation), for an app to attach to its load balancer by Ingress annotation. Set false when the client already fronts the load balancer with their own WAF"
}

# ---------------------------------------------------------------- sizes
variable "node_disk_size" {
  type        = number
  default     = 50
  description = "Root disk of each general node, GiB (encrypted gp3)"
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
