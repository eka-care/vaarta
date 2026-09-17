output "region" {
  value = var.region
}
output "url" {
  value       = local.self_url
  description = "Where vaarta answers; also its SELF_URL"
}
output "alb_dns_name" {
  value = aws_lb.this.dns_name
}
output "cluster_name" {
  value = aws_ecs_cluster.this.name
}
output "service_name" {
  value = aws_ecs_service.vaarta.name
}
output "task_definition_family" {
  value = aws_ecs_task_definition.vaarta.family
}
output "log_group" {
  value = aws_cloudwatch_log_group.vaarta.name
}
output "vpc_id" {
  value = module.vpc.vpc_id
}
output "bucket" {
  value = aws_s3_bucket.vaarta.id
}
output "rds_identifier" {
  value = module.rds.db_instance_identifier
}
output "rds_endpoint" {
  value = module.rds.db_instance_address
}
output "database_secret_name" {
  value = aws_secretsmanager_secret.database.name
}
output "waf_acl_arn" {
  value = var.waf ? aws_wafv2_web_acl.this[0].arn : ""
}
output "zone_name_servers" {
  value = local.create_dns && var.existing_zone_id == "" ? aws_route53_zone.this[0].name_servers : []
}

# For `aws ecs run-task`: a one-off migration task in the service's own subnets and security group.
output "run_task_network_configuration" {
  value = jsonencode({ awsvpcConfiguration = { subnets = module.vpc.private_subnets, securityGroups = [aws_security_group.tasks.id], assignPublicIp = "DISABLED" } })
}
output "migrate_overrides" {
  value = jsonencode({ containerOverrides = [{ name = "vaarta", command = local.migrate_command }] })
}

# --- parrotlet-a on EC2 GPU, when gpu_model = true
output "model_url" {
  value       = local.model_url
  description = "the in-cluster model endpoint vaarta calls; empty when gpu_model = false"
}
output "model_log_group" {
  value       = one(aws_cloudwatch_log_group.model[*].name)
  description = "where the model's own logs go: model load and vLLM errors"
}
output "model_service_name" {
  value = one(aws_ecs_service.model[*].name)
}
