output "cluster_name" {
  value = module.eks.cluster_name
}
output "kubeconfig_command" {
  value = "aws eks update-kubeconfig --name ${module.eks.cluster_name} --region ${var.region}"
}
output "vpc_id" {
  value = local.vpc_id
}
output "alb_controller_role_arn" {
  value = module.alb_irsa.iam_role_arn
}

# What an app module or a Helm command needs from the platform. This is the hand-off the app docs quote.
output "oidc_provider_arn" {
  value       = module.eks.oidc_provider_arn
  description = "for an app's IRSA role"
}
output "cluster_endpoint" {
  value       = module.eks.cluster_endpoint
  description = "for the helm and kubernetes providers in the deployment"
}
output "cluster_certificate_authority_data" {
  value     = module.eks.cluster_certificate_authority_data
  sensitive = true
}
output "private_subnet_ids" {
  value = local.private_subnets
}
output "node_security_group_id" {
  value = module.eks.node_security_group_id
}
output "database_name" {
  value = var.database_name
}
output "database_username" {
  value = var.database_username
}
output "certificate_arn" {
  value       = local.create_dns ? aws_acm_certificate_validation.this[0].certificate_arn : ""
  description = "for alb.ingress.kubernetes.io/certificate-arn"
}
output "domain" {
  value       = var.domain
  description = "the platform's domain, empty when none; app deployments inherit it"
}
output "zone_id" {
  value = local.zone_id
}
output "zone_name_servers" {
  value       = local.create_dns && var.existing_zone_id == "" ? aws_route53_zone.this[0].name_servers : []
  description = "delegate var.domain to these at the registrar"
}
output "rds_endpoint" {
  value = var.rds ? module.rds[0].db_instance_address : ""
}
output "rds_secret_name" {
  value = var.rds ? aws_secretsmanager_secret.rds[0].name : ""
}
output "region" {
  value = var.region
}
output "waf_acl_arn" {
  value       = var.waf ? aws_wafv2_web_acl.this[0].arn : ""
  description = "put on the Ingress as alb.ingress.kubernetes.io/wafv2-acl-arn (values-aws.yaml has the line)"
}
