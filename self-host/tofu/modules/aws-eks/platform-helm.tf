# Platform charts, installed by OpenTofu. These are cluster plumbing, not workloads: without them the
# cluster cannot route traffic or grow. GPU capacity and its device plugin come with tofu/modules/aws-eks-models. Apps are never installed here —
# they are Helm commands a person runs, and a failing app chart must never roll back a cluster
# (apps are installed by a person, never by OpenTofu).
#
# The helm provider is configured in the deployment folder, not in this module, so the module stays reusable.

# ---------------------------------------------------------------- Karpenter: IAM, the interruption queue
module "karpenter" {
  count   = var.karpenter ? 1 : 0
  source  = "terraform-aws-modules/eks/aws//modules/karpenter"
  version = "~> 20.37"

  cluster_name          = module.eks.cluster_name
  enable_v1_permissions = true

  # Pod identity rather than IRSA: the pod identity agent add-on is already on the cluster.
  enable_pod_identity             = true
  create_pod_identity_association = true

  # SSM lets you open a session on a node Karpenter launched; without it they are unreachable.
  node_iam_role_additional_policies = {
    AmazonSSMManagedInstanceCore = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
  }
}

# ---------------------------------------------------------------- the load balancer controller
# Turns an app's Ingress into an ALB. Nothing serves traffic until this exists, which is why it is
# no longer a step someone can forget.
resource "helm_release" "alb_controller" {
  name       = "aws-load-balancer-controller"
  namespace  = "kube-system"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  version    = var.alb_controller_version
  wait       = true
  timeout    = 600

  values = [yamlencode({
    clusterName = module.eks.cluster_name
    region      = var.region
    vpcId       = local.vpc_id
    serviceAccount = {
      create      = true
      name        = "aws-load-balancer-controller"
      annotations = { "eks.amazonaws.com/role-arn" = module.alb_irsa.iam_role_arn }
    }
  })]

  # Needs a node to run on: the managed node group, not anything Karpenter might later create. The network is
  # listed too, for destroy order: without it OpenTofu removes the NAT gateway in parallel with these releases,
  # the controllers lose the AWS API, and an uninstall that has to clean up in AWS (Karpenter's EC2NodeClass
  # finalizer) hangs until the Helm timeout.
  depends_on = [module.eks, module.vpc, module.vpc_endpoints]
}

# ---------------------------------------------------------------- Karpenter itself
resource "helm_release" "karpenter" {
  count      = var.karpenter ? 1 : 0
  name       = "karpenter"
  namespace  = "kube-system"
  repository = "oci://public.ecr.aws/karpenter"
  chart      = "karpenter"
  version    = var.karpenter_version
  wait       = true
  timeout    = 600

  values = [yamlencode({
    settings = {
      clusterName       = module.eks.cluster_name
      clusterEndpoint   = module.eks.cluster_endpoint
      interruptionQueue = module.karpenter[0].queue_name
    }
    serviceAccount = { name = module.karpenter[0].service_account }
    # Karpenter must never be evicted by the nodes it is managing.
    controller = {
      resources = {
        requests = { cpu = "500m", memory = "512Mi" }
        limits   = { cpu = "1", memory = "1Gi" }
      }
    }
  })]

  depends_on = [module.eks, module.karpenter, module.vpc, module.vpc_endpoints]
}

# The NodePool and EC2NodeClass are custom resources, so they ship as a chart: OpenTofu cannot plan a
# kubernetes_manifest against a CRD that does not exist yet, and Helm never reads the schema at plan time.
resource "helm_release" "karpenter_nodepool" {
  count     = var.karpenter ? 1 : 0
  name      = "karpenter-nodepool"
  namespace = "kube-system"
  chart     = "${path.module}/helm-charts/karpenter-nodepool"
  wait      = true

  values = [yamlencode({
    clusterName = module.eks.cluster_name
    nodeRole    = module.karpenter[0].node_iam_role_name
    diskSize    = "${var.node_disk_size}Gi"
    cpuLimit    = tostring(var.karpenter_cpu_limit)
  })]

  depends_on = [helm_release.karpenter, module.vpc, module.vpc_endpoints]
}
