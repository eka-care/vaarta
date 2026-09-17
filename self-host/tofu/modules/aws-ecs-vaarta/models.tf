# parrotlet-a on ECS, optional (`gpu_model = true`).
#
# Fargate has no GPU, in any region, so the model cannot run there. This adds an EC2 capacity provider to the
# same ECS cluster: an Auto Scaling group of GPU instances on the ECS GPU-optimized AMI, running only the model.
# vaarta stays on Fargate and reaches the model by a private DNS name from Cloud Map.
#
# What this costs you in operations: the GPU instances are yours to patch and pay for, unlike Fargate. They are
# fixed size, one model per instance, no autoscaling, because a model wants one whole GPU.

locals {
  model_host = var.gpu_model ? "eka-asr.${var.name}.local" : ""
  model_url  = var.gpu_model ? "http://${local.model_host}:8000/v1" : ""
}

# ---------------------------------------------------------------- service discovery
# vaarta's task needs a stable name for the model. Cloud Map gives the model service a private A record in a
# namespace that resolves inside the VPC only.
resource "aws_service_discovery_private_dns_namespace" "this" {
  count       = var.gpu_model ? 1 : 0
  name        = "${var.name}.local"
  vpc         = module.vpc.vpc_id
  description = "private DNS for ${var.name}: the model service vaarta calls"
  tags        = var.tags
}

resource "aws_service_discovery_service" "model" {
  count = var.gpu_model ? 1 : 0
  name  = "eka-asr"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this[0].id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }
  health_check_custom_config {
    failure_threshold = 1
  }
  tags = var.tags
}

# ---------------------------------------------------------------- the GPU instances
# The ECS GPU-optimized AMI carries the NVIDIA driver, the container toolkit and the ECS agent already.
data "aws_ssm_parameter" "ecs_gpu_ami" {
  count = var.gpu_model ? 1 : 0
  name  = "/aws/service/ecs/optimized-ami/amazon-linux-2023/gpu/recommended/image_id"
}

data "aws_iam_policy_document" "ec2_assume" {
  count = var.gpu_model ? 1 : 0
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "model_instance" {
  count              = var.gpu_model ? 1 : 0
  name               = "${var.name}-model-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume[0].json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "model_instance_ecs" {
  count      = var.gpu_model ? 1 : 0
  role       = aws_iam_role.model_instance[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

# SSM lets you open a shell on a GPU instance to look at nvidia-smi; without it they are unreachable.
resource "aws_iam_role_policy_attachment" "model_instance_ssm" {
  count      = var.gpu_model ? 1 : 0
  role       = aws_iam_role.model_instance[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "model" {
  count = var.gpu_model ? 1 : 0
  name  = "${var.name}-model-instance"
  role  = aws_iam_role.model_instance[0].name
  tags  = var.tags
}

resource "aws_security_group" "model" {
  count       = var.gpu_model ? 1 : 0
  name        = "${var.name}-model"
  description = "parrotlet-a tasks: reachable only from the vaarta tasks"
  vpc_id      = module.vpc.vpc_id
  tags        = var.tags
}

resource "aws_security_group_rule" "model_from_tasks" {
  count                    = var.gpu_model ? 1 : 0
  type                     = "ingress"
  from_port                = 8000
  to_port                  = 8000
  protocol                 = "tcp"
  security_group_id        = aws_security_group.model[0].id
  source_security_group_id = aws_security_group.tasks.id
  description              = "vaarta calls the model OpenAI-compatible API on 8000"
}

resource "aws_security_group_rule" "model_egress" {
  count             = var.gpu_model ? 1 : 0
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.model[0].id
  description       = "image pull and AWS APIs through the NAT gateway"
}

resource "aws_launch_template" "model" {
  count         = var.gpu_model ? 1 : 0
  name_prefix   = "${var.name}-model-"
  image_id      = data.aws_ssm_parameter.ecs_gpu_ami[0].value
  instance_type = var.gpu_instance_type

  iam_instance_profile {
    arn = aws_iam_instance_profile.model[0].arn
  }
  vpc_security_group_ids = [aws_security_group.model[0].id]

  # The model image is 24 GB and is pulled onto this disk.
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = var.gpu_disk_size
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  # The agent joins this cluster on boot. GPU support is already on in this AMI.
  user_data = base64encode(<<-EOT
    #!/bin/bash
    echo "ECS_CLUSTER=${aws_ecs_cluster.this.name}" >> /etc/ecs/ecs.config
    echo "ECS_ENABLE_GPU_SUPPORT=true" >> /etc/ecs/ecs.config
  EOT
  )

  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = "${var.name}-model" })
  }
  tags = var.tags
}

resource "aws_autoscaling_group" "model" {
  count               = var.gpu_model ? 1 : 0
  name                = "${var.name}-model"
  vpc_zone_identifier = module.vpc.private_subnets
  min_size            = var.gpu_nodes
  max_size            = var.gpu_nodes # fixed capacity: one model per instance, no autoscaling
  desired_capacity    = var.gpu_nodes

  launch_template {
    id      = aws_launch_template.model[0].id
    version = "$Latest"
  }

  # The capacity provider manages instance protection for itself.
  protect_from_scale_in = true

  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }
  dynamic "tag" {
    for_each = var.tags
    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }
}

resource "aws_ecs_capacity_provider" "model" {
  count = var.gpu_model ? 1 : 0
  name  = "${var.name}-model"
  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.model[0].arn
    managed_termination_protection = "ENABLED"
    managed_scaling {
      status                    = "ENABLED"
      target_capacity           = 100
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 1
    }
  }
  tags = var.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  count              = var.gpu_model ? 1 : 0
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", aws_ecs_capacity_provider.model[0].name]

  # vaarta keeps using Fargate by default; only the model service names the EC2 provider.
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# ---------------------------------------------------------------- the model task
resource "aws_cloudwatch_log_group" "model" {
  count             = var.gpu_model ? 1 : 0
  name              = "/ecs/${var.name}/eka-asr"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_ecs_task_definition" "model" {
  count                    = var.gpu_model ? 1 : 0
  family                   = "${var.name}-eka-asr"
  requires_compatibilities = ["EC2"] # not FARGATE: Fargate has no GPU
  network_mode             = "awsvpc"
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([{
    name      = "eka-asr"
    image     = var.model_image
    essential = true

    # One whole GPU. The instance has one, so one task fits per instance.
    resourceRequirements = [{ type = "GPU", value = "1" }]

    # vLLM's audio path needs real shared memory; the 64 MB container default breaks model load.
    linuxParameters = {
      sharedMemorySize = 16384
    }

    command = [
      "python3", "/usr/local/bin/vllm", "serve",
      "--model=${var.model_path}",
      "--max-model-len=8192",
      "--dtype=bfloat16",
      "--trust-remote-code",
      "--port=8000",
      "--max-logprobs=20",
      # Without this one failed audio request leaves vLLM's two audio caches out of step and every later
      # request hangs, while text prompts keep answering. Do not swap it for --mm-processor-cache-gb=0.
      "--mm-processor-cache-type=shm",
    ]

    portMappings = [{ containerPort = 8000, protocol = "tcp" }]

    # The image is private on Docker Hub. Put the credentials in Secrets Manager as
    # {"username":"ekacare","password":"<token>"} and pass the ARN.
    repositoryCredentials = var.model_image_credentials_arn == "" ? null : {
      credentialsParameter = var.model_image_credentials_arn
    }

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.model[0].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "eka-asr"
      }
    }

    # Model load takes many minutes on a cold pull; the start period covers it.
    healthCheck = {
      command     = ["CMD-SHELL", "curl -fsS http://127.0.0.1:8000/health || exit 1"]
      interval    = 30
      timeout     = 10
      retries     = 5
      startPeriod = 900
    }
  }])

  tags = var.tags
}

resource "aws_ecs_service" "model" {
  count           = var.gpu_model ? 1 : 0
  name            = "eka-asr"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.model[0].arn
  desired_count   = var.gpu_nodes

  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.model[0].name
    weight            = 1
  }

  network_configuration {
    subnets          = module.vpc.private_subnets
    security_groups  = [aws_security_group.model[0].id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.model[0].arn
  }

  # A model pull is slow; do not let the deployment circuit breaker kill it mid-pull.
  health_check_grace_period_seconds = 0
  wait_for_steady_state             = false

  depends_on = [aws_ecs_cluster_capacity_providers.this]
  tags       = var.tags
}
