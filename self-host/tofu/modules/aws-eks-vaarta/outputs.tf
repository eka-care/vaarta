# The two lines to copy into helm/vaarta/values-aws.yaml.
output "bucket" {
  value       = local.bucket
  description = "storage.s3.vadedBucket and nonVadedBucket"
}
output "role_arn" {
  value       = module.vaarta_irsa.iam_role_arn
  description = "serviceAccount.annotations eks.amazonaws.com/role-arn"
}
