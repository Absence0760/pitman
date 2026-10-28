# ----------------------------------------------------------------------------
# S3 bucket hosting the prerendered SvelteKit site
# ----------------------------------------------------------------------------

resource "aws_s3_bucket" "frontend" {
  bucket = "${local.project}-frontend"
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Only CloudFront (via OAC) can read objects from the bucket.
data "aws_iam_policy_document" "frontend_bucket_policy" {
  statement {
    sid       = "AllowCloudFrontServicePrincipalRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend_bucket_policy.json
}

# ----------------------------------------------------------------------------
# ACM certificate (must live in us-east-1 for CloudFront)
# ----------------------------------------------------------------------------

resource "aws_acm_certificate" "frontend" {
  provider = aws.us_east_1

  domain_name               = var.domain_name
  subject_alternative_names = ["www.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.frontend.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id
}

resource "aws_acm_certificate_validation" "frontend" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.frontend.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

# ----------------------------------------------------------------------------
# CloudFront Origin Access Control + distribution
#
# Two origins:
#   - s3-frontend (S3 bucket via OAC, signed sigv4)            -> default
#   - lambda-api (Function URL via custom_origin, shared secret) -> /api/*
#
# CloudFront stamps every /api/* request with X-CloudFront-Shared-Secret
# (random_password.cloudfront_shared_secret, also injected into the Lambda
# env). The handler rejects any request without the header. Direct hits
# to the Function URL — which is publicly reachable by AWS design — are
# rejected at the handler layer, so the WAF + per-IP rate limit on this
# distribution actually covers the API surface, not just the frontend.
# ----------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${local.project}-frontend-oac"
  description                       = "OAC for the ${local.project} frontend bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Shared secret — Terraform generates once, feeds both origin custom_header
# (below) AND Lambda env (lambda.tf). Rotates on `terraform apply -replace`
# of this resource.
resource "random_password" "cloudfront_shared_secret" {
  length  = 48
  special = false
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${local.project} frontend"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  web_acl_id          = aws_wafv2_web_acl.frontend.arn

  aliases = [var.domain_name, "www.${var.domain_name}"]

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "s3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  origin {
    # url_id is the per-Function-URL stable identifier; the full URL is
    # `https://<url_id>.lambda-url.<region>.on.aws/`. CloudFront needs
    # just the hostname here.
    domain_name = "${aws_lambda_function_url.backend.url_id}.lambda-url.${var.aws_region}.on.aws"
    origin_id   = "lambda-api"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
    custom_header {
      name  = "X-CloudFront-Shared-Secret"
      value = random_password.cloudfront_shared_secret.result
    }
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
  }

  # /api/* -> Lambda Function URL. CachingDisabled is critical here —
  # CachingOptimized would serve other users' API responses, which is at
  # best a privacy leak and at worst session bleeding. AllViewerExceptHostHeader
  # forwards everything (auth headers, body, query, cookies) except Host —
  # Host has to be the Lambda Function URL hostname for AWS to route it,
  # not the user-facing domain.
  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "lambda-api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # Managed-AllViewerExceptHostHeader
  }

  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.frontend.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

# ----------------------------------------------------------------------------
# Route 53 alias records
# ----------------------------------------------------------------------------

resource "aws_route53_record" "apex" {
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "www" {
  zone_id = var.route53_zone_id
  name    = "www.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}
