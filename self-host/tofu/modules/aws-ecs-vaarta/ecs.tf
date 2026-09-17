# vaarta as one Fargate service. The environment mirrors what helm/vaarta renders for RDS + S3,
# so the app behaves the same on ECS as on EKS.

locals {
  self_url = local.create_dns ? "https://${local.app_host}" : "http://${aws_lb.this.dns_name}"

  base_environment = {
    ENV             = "prod"
    SELF_URL        = local.self_url # known at plan time here, unlike on EKS 
    EXECUTION_MODE  = "inprocess"
    UVICORN_WORKERS = tostring(var.uvicorn_workers)
    WEB_DIST_DIR    = "/app/web-static"

    DB_BACKEND       = "postgres"
    QUEUE_BACKEND    = "postgres"
    STATE_BACKEND    = "postgres"
    ECHO_PG_HOST     = module.rds.db_instance_address
    ECHO_PG_PORT     = "5432"
    ECHO_PG_DATABASE = "scribe"
    ECHO_PG_USER     = "scribe"
    PGSSLMODE        = "require" # libpq reads it; RDS refuses plain connections anyway

    STORAGE_BACKEND          = "s3"
    STORAGE_ROOT             = "/data/storage"
    LOG_DIR                  = "/data/logs"
    AWS_REGION               = var.region
    S3_BUCKET                = aws_s3_bucket.vaarta.id
    S3_VADED_BUCKET_NAME     = aws_s3_bucket.vaarta.id
    S3_NON_VADED_BUCKET_NAME = aws_s3_bucket.vaarta.id
    BLOB_VIA_API             = "true"

    ECHO_DEFAULT_TRANSCRIBER_PROVIDER = "model_api"
    ECHO_DEFAULT_TRANSCRIBER_MODEL    = "/model/parrotlet-a"
    # With gpu_model = true, speech comes from the parrotlet-a service on the EC2 GPU instances in this
    # cluster, reached by its Cloud Map name (models.tf). Otherwise it goes to Eka's endpoint.
    MODEL_API_BASE_URL           = var.gpu_model ? local.model_url : "http://vaarta-model.bharatai.gov.in/v1"
    ECHO_DEFAULT_LLM_PROVIDER    = "openai_compatible"
    ECHO_DEFAULT_LLM_MODEL       = "eka-structuring-model"
    ECHO_LLM_BASE_URL            = "http://vaarta-model.bharatai.gov.in/v1"
    STRUCTURING_MODELS           = "eka-structuring-model"
    ECHO_DEFAULT_LLM_TEMPERATURE = "0"
    ECHO_PROMPT_PROVIDER         = "file"
    ECHO_PROMPT_DIR              = "/app/prompts"

    WORKSPACE_ID                 = "pilot-workspace"
    AUTH_ISSUER                  = "vaarta.bharatai"
    AUTH_COOKIE_SECURE           = local.create_dns ? "true" : "false" # secure cookies need HTTPS
    AUTH_ACCESS_TTL_SECONDS      = "3600"
    AUTH_REFRESH_TTL_SECONDS     = "2592000"
    AUTH_COOKIE_NAME             = "scribe_session"
    AUTH_REFRESH_COOKIE_NAME     = "scribe_refresh"
    BACKGROUND_JOB_CONCURRENCY   = "4"
    DISCOVERY_SUPPORT_EMAIL      = "admin@example.com"
    LOG_LEVEL                    = "INFO"
    FEATURE_DRUG_SEARCH          = "true"
    FEATURE_STREAMING            = "false"
    FEATURE_FHIR                 = "false"
    FEATURE_PATIENT_DIRECTORY    = "false"
    FEATURE_PAYMENTS             = "false"
    FEATURE_PUBLISH_INTEGRATIONS = "false"
    FEATURE_RECORDS_VAULT        = "false"
  }
  environment = merge(local.base_environment, var.app_environment)

  secrets = merge({
    DATABASE_URL              = "${aws_secretsmanager_secret.database.arn}:url::"
    POSTGRES_PASSWORD         = "${aws_secretsmanager_secret.database.arn}:password::"
    ECHO_PG_PASSWORD          = "${aws_secretsmanager_secret.database.arn}:password::"
    AUTH_JWT_SECRET           = "${aws_secretsmanager_secret.app.arn}:AUTH_JWT_SECRET::"
    UPLOAD_URL_SIGNING_SECRET = "${aws_secretsmanager_secret.app.arn}:UPLOAD_URL_SIGNING_SECRET::"
  }, var.provider_secret_arns)

  # setup.py's storage step probes a hardcoded bucket name and fails on S3 (a known app bug).
  migrate_command = ["/app/.venv/bin/python", "scripts/setup.py", "--non-interactive", "--no-env",
  "--skip-model-check", "--no-serve-check", "--only", "migrations,queue,seed"]
}

resource "aws_ecs_cluster" "this" {
  name = var.name
}

resource "aws_cloudwatch_log_group" "vaarta" {
  name              = "/ecs/${var.name}/vaarta"
  retention_in_days = var.log_retention_days
}

# ---------------------------------------------------------------- IAM
data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.this.account_id]
    }
  }
}

# Execution role: used by ECS itself to pull the image, write logs and read the secrets at start.
resource "aws_iam_role" "execution" {
  name               = "${var.name}-vaarta-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}
resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-vaarta-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue"]
      # provider secrets may carry a :json-key:: suffix; IAM wants the bare secret ARN
      Resource = distinct(concat(
        [aws_secretsmanager_secret.database.arn, aws_secretsmanager_secret.app.arn],
        [for v in values(var.provider_secret_arns) : regex("^arn:[^:]+:secretsmanager:[^:]+:[^:]+:secret:[^:]+", v)]
      ))
    }]
  })
}

# Task role: what the app itself can do. Only its own bucket.
resource "aws_iam_role" "task" {
  name               = "${var.name}-vaarta-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}
resource "aws_iam_role_policy" "task_s3" {
  name = "vaarta-bucket"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.vaarta.arn },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.vaarta.arn}/*" }
    ]
  })
}

# ---------------------------------------------------------------- task definition + service
resource "aws_ecs_task_definition" "vaarta" {
  family                   = "${var.name}-vaarta"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  # Scratch space on the task's ephemeral disk, the equivalent of the chart's emptyDir volumes.
  volume {
    name = "storage"
  }
  volume {
    name = "logs"
  }

  container_definitions = jsonencode([{
    name         = "vaarta"
    image        = var.image
    essential    = true
    portMappings = [{ name = "http", containerPort = 8000, protocol = "tcp" }]
    environment  = [for k in sort(keys(local.environment)) : { name = k, value = local.environment[k] }]
    secrets      = [for k in sort(keys(local.secrets)) : { name = k, valueFrom = local.secrets[k] }]
    mountPoints = [
      { sourceVolume = "storage", containerPath = "/data/storage", readOnly = false },
      { sourceVolume = "logs", containerPath = "/data/logs", readOnly = false },
    ]
    healthCheck = {
      command     = ["CMD", "python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.vaarta.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "vaarta"
      }
    }
  }])
}

resource "aws_ecs_service" "vaarta" {
  name            = "vaarta"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.vaarta.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  health_check_grace_period_seconds = 120
  wait_for_steady_state             = true # apply fails if the tasks never become healthy

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = module.vpc.private_subnets
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.vaarta.arn
    container_name   = "vaarta"
    container_port   = 8000
  }

  depends_on = [
    aws_lb_listener.http,
    aws_secretsmanager_secret_version.database,
    aws_secretsmanager_secret_version.app,
    aws_iam_role_policy.execution_secrets,
    aws_iam_role_policy_attachment.execution,
  ]
}
