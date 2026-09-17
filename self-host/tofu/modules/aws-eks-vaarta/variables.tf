# The two things vaarta needs in AWS that Helm cannot create: a bucket and an IAM role the pod assumes to
# reach it. Optional: the guide says how to make both by hand; this module is the shortcut. It takes facts
# about the cluster, never its state, so it works on any EKS cluster.

variable "cluster_name" {
  type        = string
  description = "the EKS cluster vaarta is installed into; also prefixes what this module creates"
}
variable "region" { type = string }
variable "namespace" {
  type        = string
  default     = "eka-care"
  description = "namespace vaarta is installed into; the IAM trust is scoped to it"
}
variable "service_account" {
  type        = string
  default     = "vaarta"
  description = "vaarta's ServiceAccount name; values-aws.yaml sets the same"
}
variable "oidc_provider_arn" {
  type        = string
  default     = ""
  description = "the cluster's IAM OIDC provider. Empty = looked up from the cluster, which is the normal case"
}
variable "existing_bucket" {
  type        = string
  default     = ""
  description = "a bucket you already have; the module then creates only the role, scoped to it"
}
variable "tags" {
  type    = map(string)
  default = {}
}
