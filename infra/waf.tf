# ----------------------------------------------------------------------------
# WAF: per-IP rate limits on the CloudFront distribution (us-east-1: scope
# CLOUDFRONT is a hard AWS constraint).
#
# Covers the whole site, API included: the browser calls same-origin /api/*,
# CloudFront proxies it to the Function URL with the shared secret, and the
# app rejects requests that skip CloudFront.
#
# Two rules, tightest first:
#   - /api/*: waf_api_rate_limit_per_ip (default 300 per 5 minutes). Each is
#     a Lambda invocation, and a CHIRPS read is up to a few hundred S3 GETs
#     billed to IC-WBT. Extending one network is a handful of calls.
#   - every path: waf_site_rate_limit_per_ip (default 2,000), a backstop for
#     the edge-cached static site (a cold visit is ~20 requests).
# A distributed flood is the invocation alarm's and the budget's job
# (alarms.tf), and reserved concurrency caps what it can cost (lambda.tf).
#
# No AWS managed rule groups: AWSManagedRulesCommonRuleSet blocks bodies
# over 8 KB, and a quaternary polygon POSTed to /api/chirps/monthly can be
# larger. The API enforces its own input-size limits (4.2).
#
# Cost: ~$5/month for the ACL + $1/month per rule + $0.60 per 1M requests.
# ----------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "frontend" {
  provider = aws.us_east_1
  name     = "${local.project}-frontend-acl"
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "RateLimitApiPerIP"
    priority = 0

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_api_rate_limit_per_ip
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        scope_down_statement {
          byte_match_statement {
            search_string         = "/api/"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            # Match the path CloudFront routes on, not its raw spelling:
            # decode, then collapse //, /./ and /../, then fold case.
            text_transformation {
              priority = 0
              type     = "URL_DECODE"
            }
            text_transformation {
              priority = 1
              type     = "NORMALIZE_PATH"
            }
            text_transformation {
              priority = 2
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.project}-RateLimitApiPerIP"
    }
  }

  rule {
    name     = "RateLimitSitePerIP"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_site_rate_limit_per_ip
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.project}-RateLimitSitePerIP"
    }
  }

  visibility_config {
    sampled_requests_enabled   = true
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.project}-frontend-acl"
  }

  lifecycle {
    precondition {
      condition     = var.waf_site_rate_limit_per_ip >= var.waf_api_rate_limit_per_ip
      error_message = "waf_site_rate_limit_per_ip must be at least waf_api_rate_limit_per_ip (the site rule counts the API's requests too)."
    }
  }
}
