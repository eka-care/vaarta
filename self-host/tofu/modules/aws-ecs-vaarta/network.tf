data "aws_availability_zones" "this" { state = "available" }
data "aws_caller_identity" "this" {}

locals {
  azs                  = slice(data.aws_availability_zones.this.names, 0, var.az_count)
  private_subnet_cidrs = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnet_cidrs  = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, 100 + i)]
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.21"

  name            = var.name
  cidr            = var.vpc_cidr
  azs             = local.azs
  private_subnets = local.private_subnet_cidrs
  public_subnets  = local.public_subnet_cidrs

  enable_nat_gateway     = true
  single_nat_gateway     = var.single_nat
  one_nat_gateway_per_az = !var.single_nat
  enable_dns_hostnames   = true
}

# S3 traffic from the tasks stays off the NAT gateway
module "vpc_endpoints" {
  source  = "terraform-aws-modules/vpc/aws//modules/vpc-endpoints"
  version = "~> 5.21"
  vpc_id  = module.vpc.vpc_id
  endpoints = {
    s3 = { service = "s3", service_type = "Gateway", route_table_ids = module.vpc.private_route_table_ids }
  }
}

# ---------------------------------------------------------------- security groups: internet -> ALB -> tasks -> RDS
resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Public entry to the vaarta load balancer"
  vpc_id      = module.vpc.vpc_id
}
resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}
resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  count             = local.create_dns ? 1 : 0
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 8000
  to_port                      = 8000
}

resource "aws_security_group" "tasks" {
  name        = "${var.name}-vaarta-tasks"
  description = "vaarta tasks: HTTP from the load balancer only"
  vpc_id      = module.vpc.vpc_id
}
resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 8000
  to_port                      = 8000
}
# Outbound: ECR and CloudWatch through NAT, S3 through the endpoint, RDS, and the model / LLM providers.
resource "aws_vpc_security_group_egress_rule" "tasks_all" {
  security_group_id = aws_security_group.tasks.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "rds" {
  name        = "${var.name}-rds"
  description = "Postgres from the vaarta tasks only"
  vpc_id      = module.vpc.vpc_id
}
resource "aws_vpc_security_group_ingress_rule" "rds_from_tasks" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
