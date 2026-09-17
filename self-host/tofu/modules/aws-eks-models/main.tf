# Everything about the cluster is read from the cluster itself. Its version picks the AMI, its service CIDR
# goes into the node bootstrap, its security group lets the nodes talk to the control plane.
data "aws_eks_cluster" "this" {
  name = var.cluster_name
}

# The nodes go into private subnets. When none are named, take the cluster's own and keep only those that
# do not hand out public IPs: a foreign cluster may list public subnets too, and a GPU node must not land
# in one by accident.
data "aws_subnet" "cluster" {
  for_each = length(var.subnet_ids) == 0 ? toset(data.aws_eks_cluster.this.vpc_config[0].subnet_ids) : toset([])
  id       = each.key
}
locals {
  subnet_ids = length(var.subnet_ids) > 0 ? var.subnet_ids : [
    for s in data.aws_subnet.cluster : s.id if !s.map_public_ip_on_launch
  ]
}

resource "terraform_data" "facts" {
  lifecycle {
    precondition {
      condition     = length(local.subnet_ids) > 0
      error_message = "no private subnet found for the GPU nodes: the cluster's subnets all assign public IPs. Pass subnet_ids explicitly."
    }
  }
}

# ---------------------------------------------------------------- the node group
# The same managed node group the platform used to carry, now attachable to any cluster. EKS registers the
# node role with the cluster itself (an access entry, or the aws-auth ConfigMap on older clusters), so the
# cluster's own authentication configuration is never edited here.
module "gpu" {
  source  = "terraform-aws-modules/eks/aws//modules/eks-managed-node-group"
  version = "~> 20.37"

  name            = "${var.cluster_name}-gpu"
  cluster_name    = var.cluster_name
  cluster_version = data.aws_eks_cluster.this.version
  subnet_ids      = local.subnet_ids

  cluster_primary_security_group_id = data.aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  cluster_service_cidr              = data.aws_eks_cluster.this.kubernetes_network_config[0].service_ipv4_cidr
  vpc_security_group_ids            = [data.aws_eks_cluster.this.vpc_config[0].cluster_security_group_id]

  create_iam_role = var.node_role_arn == ""
  iam_role_arn    = var.node_role_arn != "" ? var.node_role_arn : null

  instance_types = [var.gpu_instance_type]
  ami_type       = "AL2023_x86_64_NVIDIA" # NVIDIA driver and container toolkit; the device plugin is below
  min_size       = var.gpu_nodes
  max_size       = var.gpu_nodes # fixed capacity: no autoscaling on model nodes
  desired_size   = var.gpu_nodes

  # disk_size is ignored when the module builds its own launch template (its default), which would leave the
  # nodes on the image's 20 GiB unencrypted root. Set the root volume explicitly instead.
  block_device_mappings = {
    xvda = {
      device_name = "/dev/xvda"
      ebs = {
        volume_size           = var.gpu_disk_size
        volume_type           = "gp3"
        encrypted             = true
        delete_on_termination = true
      }
    }
  }

  labels = { "eka.care/gpu" = "true" }
  taints = { gpu = { key = "nvidia.com/gpu", value = "true", effect = "NO_SCHEDULE" } }
  tags   = var.tags
}

# ---------------------------------------------------------------- the device plugin
# The NVIDIA EKS image carries the driver and container toolkit but not the Kubernetes device plugin, so
# nvidia.com/gpu is not a schedulable resource until this runs. Installed here because a node group without
# it is a GPU nobody can use; skipped when the cluster already has one.
resource "helm_release" "nvidia_device_plugin" {
  count      = var.install_device_plugin ? 1 : 0
  name       = "nvidia-device-plugin"
  namespace  = "kube-system"
  repository = "https://nvidia.github.io/k8s-device-plugin"
  chart      = "nvidia-device-plugin"
  version    = var.device_plugin_version
  wait       = true
  timeout    = 600

  values = [yamlencode({
    nodeSelector = { "eka.care/gpu" = "true" }
    tolerations = [
      { key = "nvidia.com/gpu", operator = "Exists", effect = "NoSchedule" },
      { key = "CriticalAddonsOnly", operator = "Exists" },
    ]
  })]

  depends_on = [module.gpu]
}
