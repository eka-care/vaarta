locals {
  create_dns = var.domain != ""
  app_host   = local.create_dns ? "${var.app_subdomain}.${var.domain}" : ""
  zone_id    = var.existing_zone_id != "" ? var.existing_zone_id : (local.create_dns ? aws_route53_zone.this[0].zone_id : "")
}

resource "aws_lb" "this" {
  name                       = "${var.name}-vaarta"
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = module.vpc.public_subnets
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "vaarta" {
  name                 = "${var.name}-vaarta"
  port                 = 8000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = module.vpc.vpc_id
  deregistration_delay = 30
  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# Port 80: forwards to the app with no domain, redirects to HTTPS with one.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  dynamic "default_action" {
    for_each = local.create_dns ? [] : [1]
    content {
      type             = "forward"
      target_group_arn = aws_lb_target_group.vaarta.arn
    }
  }
  dynamic "default_action" {
    for_each = local.create_dns ? [1] : []
    content {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = local.create_dns ? 1 : 0
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.this[0].certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.vaarta.arn
  }
}

# ---------------------------------------------------------------- DNS + certificate, only with a domain
resource "aws_route53_zone" "this" {
  count = local.create_dns && var.existing_zone_id == "" ? 1 : 0
  name  = var.domain
}
resource "aws_acm_certificate" "this" {
  count             = local.create_dns ? 1 : 0
  domain_name       = local.app_host
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}
resource "aws_route53_record" "acm" {
  for_each = local.create_dns ? { for o in aws_acm_certificate.this[0].domain_validation_options : o.domain_name => o } : {}
  zone_id  = local.zone_id
  name     = each.value.resource_record_name
  type     = each.value.resource_record_type
  records  = [each.value.resource_record_value]
  ttl      = 60
}
resource "aws_acm_certificate_validation" "this" {
  count                   = local.create_dns ? 1 : 0
  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for r in aws_route53_record.acm : r.fqdn]
}
resource "aws_route53_record" "app" {
  count   = local.create_dns ? 1 : 0
  zone_id = local.zone_id
  name    = local.app_host
  type    = "A"
  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}
