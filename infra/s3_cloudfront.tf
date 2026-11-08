# ----------------------------------------------------------------------------
# Site bucket: the prerendered SvelteKit build. Private; CloudFront reads it
# through Origin Access Control and nothing else can.
# ----------------------------------------------------------------------------

resource "aws_s3_bucket" "frontend" {
  # Bucket names are global: the account ID makes this one unclaimable by
  # anyone else and collision-free.
  bucket = "${local.project}-frontend-${local.account_id}"
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

# Only this distribution (OAC, SourceArn) may read; every request must be TLS.
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

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.frontend.arn, "${aws_s3_bucket.frontend.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend_bucket_policy.json

  depends_on = [aws_s3_bucket_public_access_block.frontend]
}

# ----------------------------------------------------------------------------
# DNS: the delegated child zone (pitman.jaredhoward.com) is created by the
# estate bootstrap (new-project-account.sh) in this account; looked up here.
# ----------------------------------------------------------------------------

data "aws_route53_zone" "site" {
  name         = var.domain_name
  private_zone = false
}

# ----------------------------------------------------------------------------
# ACM certificate (us-east-1, as CloudFront requires), DNS-validated in the
# child zone. One name: no www (www.pitman.jaredhoward.com has no use).
# ----------------------------------------------------------------------------

resource "aws_acm_certificate" "frontend" {
  provider = aws.us_east_1

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# Keyed by the (static) domain names rather than by the certificate's
# validation options, so the keys are known before the certificate exists.
locals {
  cert_validation = {
    for dvo in aws_acm_certificate.frontend.domain_validation_options : dvo.domain_name => dvo
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = toset([var.domain_name])

  allow_overwrite = true
  name            = local.cert_validation[each.key].resource_record_name
  records         = [local.cert_validation[each.key].resource_record_value]
  ttl             = 60
  type            = local.cert_validation[each.key].resource_record_type
  zone_id         = data.aws_route53_zone.site.zone_id
}

resource "aws_acm_certificate_validation" "frontend" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.frontend.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

# ----------------------------------------------------------------------------
# CloudFront Functions (viewer request); code and comments in functions/,
# tested by scripts/cloudfront-functions.test.mjs. $0.10 per million. The
# viewer-response ones, the security headers, are in security_headers.tf.
# ----------------------------------------------------------------------------

resource "aws_cloudfront_function" "spa_rewrite" {
  name    = "${local.project}-spa-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Serve /index.html for extension-less client routes"
  publish = true
  code    = file("${path.module}/functions/spa_rewrite.js")
}

resource "aws_cloudfront_function" "api_strip_prefix" {
  name    = "${local.project}-api-strip-prefix"
  runtime = "cloudfront-js-2.0"
  comment = "Strip the /api prefix before the Lambda Function URL"
  publish = true
  code    = file("${path.module}/functions/api_strip_prefix.js")
}

# ----------------------------------------------------------------------------
# Origin Access Control + distribution
#
# Two origins, each behind its own OAC (SigV4):
#   s3-frontend: the site bucket                                    -> default
#   lambda-api:  the Function URL (AWS_IAM), plus the shared secret -> /api/*
#
# The API has two locks (issue #33, decision R4-I6):
#   1. OAC. The Function URL is AWS_IAM (lambda.tf) and admits only requests
#      CloudFront signs for this distribution (the two permissions below), so
#      a direct hit is refused by Lambda's front end with 403 before the
#      function runs: never billed, and the WAF + rate limits really cover
#      the API. The price: CloudFront signs the body hash the viewer states,
#      so the frontend sends x-amz-content-sha256 on every POST/PUT/PATCH/
#      DELETE (frontend/src/lib/api/content-hash.ts); one without it is 403.
#   2. The shared secret. CloudFront stamps every /api/* request with
#      X-CloudFront-Shared-Secret (random_password below, also in the
#      Lambda's env) and the app refuses any request without it
#      (backend/src/app.ts). Kept as a second layer: it still holds if the
#      OAC is ever detached or set to `never` sign, or the URL goes back to
#      NONE, by mistake or during an incident, and it costs nothing.
# ----------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${local.project}-frontend-oac"
  description                       = "OAC for the ${local.project} site bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# `always`, never `no-override`: the API reads no viewer Authorization header
# (the session is a cookie), so CloudFront's signature always replaces one.
resource "aws_cloudfront_origin_access_control" "api" {
  name                              = "${local.project}-api-oac"
  description                       = "OAC for the ${local.project} API Lambda Function URL"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# The Function URL's resource policy: CloudFront, on behalf of this
# distribution only (source_arn), may invoke it. Since October 2025 a
# Function URL needs both actions (AWS CloudFront Developer Guide,
# "Restrict access to an AWS Lambda function URL origin", whose two
# add-permission commands these mirror; Lambda Developer Guide, "Control
# access to Lambda function URLs"). lambda:InvokedViaFunctionUrl is not set
# on the second: the CloudFront guide's command leaves it out, and the grant
# is already narrowed to one caller (this distribution), which reaches the
# function only through its origin.
resource "aws_lambda_permission" "cloudfront_invoke_url" {
  statement_id           = "AllowCloudFrontServicePrincipal"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.backend.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.frontend.arn
  function_url_auth_type = "AWS_IAM"
}

resource "aws_lambda_permission" "cloudfront_invoke_function" {
  statement_id  = "AllowCloudFrontServicePrincipalInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.backend.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.frontend.arn
}

# Generated once; feeds the origin's custom_header and the Lambda env. It is
# in the Terraform state (encrypted S3, this account only). Rotate with
# `terraform apply -replace=random_password.cloudfront_shared_secret`
# (CloudFront and the Lambda update in the same apply; a few seconds of 403s
# while the distribution propagates).
resource "random_password" "cloudfront_shared_secret" {
  length  = 48
  special = false
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  comment             = "${local.project} site + /api"
  default_root_object = "index.html"
  # PriceClass_200 includes the South African edges (Johannesburg, Cape
  # Town); _100 is North America + Europe only, which would put every SA
  # user's request through Europe.
  price_class = "PriceClass_200"
  web_acl_id  = aws_wafv2_web_acl.frontend.arn

  aliases = [var.domain_name]

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "s3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  origin {
    # url_id is the Function URL's stable id: https://<url_id>.lambda-url.<region>.on.aws/
    domain_name              = "${aws_lambda_function_url.backend.url_id}.lambda-url.${var.aws_region}.on.aws"
    origin_id                = "lambda-api"
    origin_access_control_id = aws_cloudfront_origin_access_control.api.id
    # https-only is required for a Lambda OAC.
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      # Same as the Lambda timeout (variables.tf).
      origin_read_timeout = var.lambda_timeout_seconds
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
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }

    # The security headers (security_headers.tf); no response headers policy.
    function_association {
      event_type   = "viewer-response"
      function_arn = aws_cloudfront_function.site_headers.arn
    }
  }

  # /api/* -> Lambda Function URL. CachingDisabled: the API's own caching (by
  # quaternary, 4.2) is in the app; an edge cache keyed wrongly would serve
  # one request's answer to another. AllViewerExceptHostHeader forwards body,
  # query and headers but not Host, which must be the Function URL's own for
  # AWS to route it. That includes every cookie and the Origin header, which
  # sign-in needs (the __Host-pitman_session cookie, csrf() on Origin; A-AUTH-3,
  # A-AUTH-9); with caching disabled nothing is keyed on them, so one user's
  # answer is never served to another (a terraform test pins both).
  # Not forwarding Host is also what the OAC signature needs: CloudFront signs
  # for the Function URL's host, and a viewer Host passed through would not
  # match it (403). The viewer's x-amz-content-sha256 is forwarded with the
  # rest, and is the payload hash CloudFront signs.
  # https-only: an http:// API call is refused, not redirected (a redirect would turn a POST into a GET).
  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "lambda-api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # Managed-AllViewerExceptHostHeader

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.api_strip_prefix.arn
    }

    # The API's security headers on 2xx/3xx; the app sets the same ones on
    # its errors, where no viewer-response function runs (security_headers.tf).
    function_association {
      event_type   = "viewer-response"
      function_arn = aws_cloudfront_function.api_headers.arn
    }
  }

  # No custom_error_response: it applies to every origin, so it would turn the
  # API's JSON 403/404 into the HTML page. Client routes are spa_rewrite's job.

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
# Route 53 alias records (IPv4 + IPv6)
# ----------------------------------------------------------------------------

resource "aws_route53_record" "site" {
  for_each = toset(["A", "AAAA"])

  zone_id = data.aws_route53_zone.site.zone_id
  name    = var.domain_name
  type    = each.key

  alias {
    name                   = aws_cloudfront_distribution.frontend.domain_name
    zone_id                = aws_cloudfront_distribution.frontend.hosted_zone_id
    evaluate_target_health = false
  }
}
