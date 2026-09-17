variable "name" {
  type        = string
  description = "prefixes every resource, and names the cluster"
}
variable "region" {
  type    = string
  default = "ap-south-1"
}
variable "namespace" {
  type        = string
  default     = "eka-care"
  description = "the Kubernetes namespace vaarta is installed into; the IAM role trusts <namespace>:vaarta"
}
variable "domain" {
  type        = string
  default     = ""
  description = "empty = the app answers on the load balancer hostname over HTTP. Set it for a Route 53 zone, an ACM certificate and HTTPS"
}

# --- GPU for parrotlet-a
variable "gpu_nodes" {
  type        = number
  default     = 0
  description = "0 = speech and notes from Eka's model endpoint, no GPU cost. 1 = parrotlet-a here. 2 = parrotlet-t too"
}
variable "gpu_instance_type" {
  type    = string
  default = "g6.2xlarge"
}
variable "gpu_disk_size" {
  type    = number
  default = 200
}

# --- the cluster
variable "kubernetes_version" {
  type    = string
  default = "1.36"
}
variable "node_instance_type" {
  type    = string
  default = "t3.medium"
}
variable "node_count" {
  type    = number
  default = 2
}
variable "node_max" {
  type    = number
  default = 6
}

# --- the network
variable "vpc_cidr" {
  type        = string
  default     = "10.60.0.0/16"
  description = "must not overlap anything you peer with or reach over VPN. Subnets derive from it"
}
variable "az_count" {
  type    = number
  default = 2
}
variable "single_nat" {
  type        = bool
  default     = true
  description = "one NAT gateway; false for one per AZ"
}

# --- the database
variable "rds" {
  type        = bool
  default     = true
  description = "true = RDS for PostgreSQL. false = the chart's bundled Postgres, for a throwaway cluster"
}
variable "rds_instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "rds_multi_az" {
  type    = bool
  default = false
}
variable "database_name" {
  type    = string
  default = "app"
}
variable "database_username" {
  type    = string
  default = "app"
}

# --- the edge
variable "waf" {
  type        = bool
  default     = true
  description = "regional web ACL with AWS managed rules on the load balancer"
}
variable "cluster_public_access" {
  type        = bool
  default     = true
  description = "how kubectl reaches the API from a laptop. Narrow the CIDRs, then turn this off, once a VPN exists"
}
variable "cluster_public_access_cidrs" {
  type    = list(string)
  default = ["0.0.0.0/0"]
}

variable "tags" {
  type    = map(string)
  default = {}
}
