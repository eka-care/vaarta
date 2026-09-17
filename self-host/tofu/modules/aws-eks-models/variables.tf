# GPU capacity for the models, attached to any EKS cluster: the kit's platform, an existing one, someone
# else's. The module takes facts about the cluster, never its state . Two facts are required:
# the cluster's name and region. It adds a fixed-size managed node group on the NVIDIA image and installs
# the device plugin that makes nvidia.com/gpu schedulable. It installs no model: that is a Helm command.

variable "cluster_name" {
  type        = string
  description = "the EKS cluster to add GPU nodes to; also prefixes what this module creates"
}
variable "region" { type = string }

variable "gpu_nodes" {
  type        = number
  default     = 1
  description = "fixed number of GPU nodes, one model per node: 1 for speech (parrotlet-a), 2 for speech and notes (parrotlet-t). No autoscaling"
  validation {
    condition     = var.gpu_nodes >= 1
    error_message = "gpu_nodes must be at least 1; to have no GPU nodes, do not apply this module."
  }
}
variable "gpu_instance_type" {
  type        = string
  default     = "g6.2xlarge"
  description = "NVIDIA Ampere or newer: g5.* (A10G), g6.* (L4), g6e.* (L40S). g4dn is rejected. g6.2xlarge is 8 vCPU, 32 GiB, one L4"
  # A `validation` fails the plan; a `check` block only warns, and an earlier version of this guard let g4dn through.
  validation {
    condition     = can(regex("^(g5|g6|g6e|p4d|p4de|p5|p5e|p5en)\\.", var.gpu_instance_type))
    error_message = "gpu_instance_type must be g5/g6/g6e/p4d/p5 (NVIDIA Ampere or newer); g4dn/T4 does not run the models."
  }
}
variable "gpu_disk_size" {
  type        = number
  default     = 200
  description = "root disk of each GPU node, GiB; the model images are 24 and 35 GB and are pulled onto it"
}
variable "subnet_ids" {
  type        = list(string)
  default     = []
  description = "private subnets for the nodes. Empty = the cluster's own subnets that do not assign public IPs"
}
variable "node_role_arn" {
  type        = string
  default     = ""
  description = "an IAM role for the nodes, if the cluster already has one to share. Empty = the module creates one"
}

variable "install_device_plugin" {
  type        = bool
  default     = true
  description = "install NVIDIA's device plugin. false when the cluster already runs one (EKS Auto Mode ships it)"
}
variable "device_plugin_version" {
  type    = string
  default = "0.20.0"
}
variable "tags" {
  type    = map(string)
  default = {}
}
