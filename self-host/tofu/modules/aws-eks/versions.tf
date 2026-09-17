terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = ">= 5.95, < 6.0" } # the community modules pinned here require < 6.0
    random = { source = "hashicorp/random", version = "~> 3.6" }
    local  = { source = "hashicorp/local", version = "~> 2.5" }
    # Platform charts only — the load balancer controller and Karpenter.
    # Never an app chart: apps are installed by hand with Helm (apps are installed by a person, never by OpenTofu).
    # The provider is configured in the deployment folder, not here, so this module stays reusable.
    helm = { source = "hashicorp/helm", version = "~> 2.17" }
  }
}
