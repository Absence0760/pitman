# ----------------------------------------------------------------------------
# WAF: per-IP rate limits on the CloudFront distribution (us-east-1: scope
# CLOUDFRONT is a hard AWS constraint).
#
# Covers the whole site, API included: the browser calls same-origin /api/*,
# CloudFront proxies it to the Function URL with the shared secret, and the
# app rejects requests that skip CloudFront.
#
# Three rules, tightest first:
#   - /api/auth/* except /api/auth/me: auth_waf_rate_limit_per_ip (default
#     100 per 5 minutes, the AWS minimum; A-AUTH-9). Sign-in is two or three
#     calls; auth-kit's per-address limits are the real bound, this slows one
#     source spraying code guesses (or lockouts) across many addresses.
#     /api/auth/me runs on every page load (the layout asks who is signed in),
#     so it is left to the /api/ rule: an office behind one NAT browsing the
#     site never spends the sign-in budget.
#   - /api/*: waf_api_rate_limit_per_ip (default 300 per 5 minutes). Each is
#     a Lambda invocation, and a CHIRPS read is at most 720 S3 GETs (16
#     chunks, R4-D6) billed to IC-WBT, and at most 144,000 per user per day
#     (R4-D7). Extending one network is a handful of calls.
#   - every path: waf_site_rate_limit_per_ip (default 2,000), a backstop for
#     the edge-cached static site (a cold visit is ~20 requests).
# A distributed flood is the invocation alarm's and the budget's job
# (alarms.tf); reserved concurrency caps what it can cost (lambda.tf) and the
# breaker stops it (breaker.tf).
#
# No AWS managed rule groups: AWSManagedRulesCommonRuleSet blocks bodies
# over 8 KB, and a quaternary polygon POSTed to /api/chirps/monthly can be
# larger. The API enforces its own input-size limits (4.2).
#
# Sampled requests are off on the ACL and every rule (metrics stay on): a
# sample keeps the request's headers, the session cookie among them, and the
# client IP in us-east-1 for about 3 hours, and samples can't be redacted.
# docs/security.md § Infrastructure.
#
# Cost: ~$5/month for the ACL + $1/month per rule (three) + $0.60 per 1M requests.
# ----------------------------------------------------------------------------

# The text transformations every path match uses, in order, so the match is on
# the path the app routes, not its raw spelling:
#   1. URL_DECODE: %61 -> a, %2f -> /, %5c -> \.
#   2. NORMALIZE_PATH_WIN: turn \ into / (the app routes /auth\code as
#      /auth/code), then collapse //, /./ and /../ (it is NORMALIZE_PATH after
#      the backslash step, so it replaces it). After the decode, so an encoded
#      backslash is folded too.
#   3. LOWERCASE.
# Each transformation costs 10 WCUs; the ACL stays far under its 1,500.
locals {
  waf_path_transformations = ["URL_DECODE", "NORMALIZE_PATH_WIN", "LOWERCASE"]
}

resource "aws_wafv2_web_acl" "frontend" {
  provider = aws.us_east_1
  name     = "${local.project}-frontend-acl"
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "RateLimitAuthPerIP"
    priority = 0

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = var.auth_waf_rate_limit_per_ip
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        # /api/auth/... but not /api/auth/me, both on the same normalised path.
        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                search_string         = "/api/auth/"
                positional_constraint = "STARTS_WITH"
                field_to_match {
                  uri_path {}
                }
                dynamic "text_transformation" {
                  for_each = local.waf_path_transformations
                  content {
                    priority = text_transformation.key
                    type     = text_transformation.value
                  }
                }
              }
            }
            statement {
              not_statement {
                statement {
                  byte_match_statement {
                    search_string         = "/api/auth/me"
                    positional_constraint = "EXACTLY"
                    field_to_match {
                      uri_path {}
                    }
                    dynamic "text_transformation" {
                      for_each = local.waf_path_transformations
                      content {
                        priority = text_transformation.key
                        type     = text_transformation.value
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      sampled_requests_enabled   = false
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.project}-RateLimitAuthPerIP"
    }
  }

  rule {
    name     = "RateLimitApiPerIP"
    priority = 1

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
            dynamic "text_transformation" {
              for_each = local.waf_path_transformations
              content {
                priority = text_transformation.key
                type     = text_transformation.value
              }
            }
          }
        }
      }
    }

    visibility_config {
      sampled_requests_enabled   = false
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.project}-RateLimitApiPerIP"
    }
  }

  rule {
    name     = "RateLimitSitePerIP"
    priority = 2

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
      sampled_requests_enabled   = false
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.project}-RateLimitSitePerIP"
    }
  }

  # The metric name differs from the ACL's name on purpose: WAF's WebACL
  # dimension is the metric name, and the difference makes an alarm that
  # used the ACL's name fail its test (tests/auth.tftest.hcl).
  visibility_config {
    sampled_requests_enabled   = false
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.project}-frontend-acl-metric"
  }

  lifecycle {
    precondition {
      condition     = var.waf_api_rate_limit_per_ip >= var.auth_waf_rate_limit_per_ip
      error_message = "waf_api_rate_limit_per_ip must be at least auth_waf_rate_limit_per_ip (the /api/ rule counts /api/auth/ requests too)."
    }
    precondition {
      condition     = var.waf_site_rate_limit_per_ip >= var.waf_api_rate_limit_per_ip
      error_message = "waf_site_rate_limit_per_ip must be at least waf_api_rate_limit_per_ip (the site rule counts the API's requests too)."
    }
  }
}
