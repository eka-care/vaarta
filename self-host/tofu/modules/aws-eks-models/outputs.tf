output "gpu_nodes" {
  value       = var.gpu_nodes
  description = "a fact for vaarta's deployment: 1 points speech at the in-cluster eka-asr, 2 also points notes at parrotlet-t"
}
output "node_group_name" {
  value = module.gpu.node_group_id
}
output "node_role_arn" {
  value = module.gpu.iam_role_arn
}
output "subnet_ids" {
  value = local.subnet_ids
}
