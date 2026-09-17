# tofu/modules/aws-ecs-vaarta — a module, not a place to run OpenTofu

Copy `tofu/ecs` and run OpenTofu there. Nothing here is executed directly.

**vaarta on ECS Fargate, infrastructure and app in one apply.** Builds a VPC, an ECS cluster with one Fargate
service, an ALB with WAF, RDS for PostgreSQL 16, an S3 bucket, Secrets Manager secrets, CloudWatch log groups,
and a Route 53 zone + ACM certificate when a domain is set. It shares no code with `tofu/modules/aws-eks`;
it duplicates the VPC, RDS, S3 and WAF blocks on purpose, so the ECS path stands alone.

## Inputs

| Variable | Default | Notes |
|---|---|---|
| `name` | — | required; prefixes every resource |
| `image` | — | required; full image URI with tag |
| `region` | `ap-south-1` | |
| `cpu_architecture` | `X86_64` | must match the image you pushed; `ARM64` is cheaper Fargate and the image is published for both |
| `cpu` / `memory` / `desired_count` | 1024 / 2048 / 1 | keep one task while `EXECUTION_MODE` is `inprocess` |
| `uvicorn_workers` | 2 | |
| `app_environment` | {} | plain settings merged over the defaults, e.g. ASR provider and model |
| `provider_secret_arns` | {} | env var → Secrets Manager ARN (with `:key::`) for provider API keys |
| `vpc_cidr` / `az_count` / `single_nat` | `10.70.0.0/16` / 2 / true | |
| `domain` / `app_subdomain` / `existing_zone_id` | "" / `scribe` / "" | empty domain = HTTP on the ALB hostname |
| `waf` | true | |
| `rds_instance_class` / `rds_multi_az` | `db.t4g.medium` / false | |
| `rds_allocated_storage` / `rds_max_allocated_storage` | 50 / 500 GB | storage at creation / autoscaling ceiling |
| `log_retention_days` | 180 | app and Postgres logs |
| `tags` | {} | |

## Outputs

`region`, `url`, `alb_dns_name`, `cluster_name`, `service_name`, `task_definition_family`, `log_group`, `vpc_id`,
`bucket`, `rds_identifier`, `rds_endpoint`, `database_secret_name`, `waf_acl_arn`, `zone_name_servers`,
`run_task_network_configuration`, `migrate_overrides`.

The task environment mirrors what `helm/vaarta` renders for RDS + S3, so the app behaves the same as on EKS.
Two things differ because ECS cannot compose variables: the full `DATABASE_URL` is stored ready-made in the
database secret, and `SELF_URL` comes straight from the load balancer or the domain.

Migrations are not run by OpenTofu. The guide runs them as a one-off task using the last two outputs:
`docs/ecs.md`, step 4.
