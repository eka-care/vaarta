terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = ">= 5.95, < 6.0" } # the community modules pinned here require < 6.0
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}
provider "aws" {
  region = var.region
  default_tags {
    tags = merge({ Project = "eka-deploy", Environment = var.name, App = "vaarta" }, var.tags)
  }
}
