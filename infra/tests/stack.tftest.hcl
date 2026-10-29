# Credential-free tests of the stack's load-bearing settings: mocked
# providers, `command = plan`, no AWS account, no state.
#   terraform -chdir=infra init -backend=false && terraform -chdir=infra test
#
# They pin what a careless edit could quietly loosen: the cross-account
# grants on IC-WBT's buckets (docs/data.md § Cross-account access), the
# Lambda's cost bounds, the CSP, and the /api/* edge behaviour.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111111111111"
    }
  }
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
  mock_data "aws_iam_role" {
    defaults = {
      arn  = "arn:aws:iam::111111111111:role/pitman-deploy"
      name = "pitman-deploy"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
}

mock_provider "random" {}
mock_provider "archive" {}

# --- defaults: nothing granted across accounts ------------------------------

run "defaults_grant_nothing_cross_account" {
  command = plan

  assert {
    condition     = length(aws_iam_role_policy.lambda_cross_account_read) == 0
    error_message = "With no IC-WBT variables set, the Lambda must have no cross-account policy."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["CHIRPS_SOURCE"] == ""
    error_message = "CHIRPS_SOURCE must be empty until the CHIRPS grant exists."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["MAP_GRID_SOURCE"] == ""
    error_message = "MAP_GRID_SOURCE must be empty until the MAP-grid grant exists."
  }
}

run "bucket_without_account_grants_nothing" {
  command = plan

  variables {
    chirps_bucket   = "water-management-mirror-222222222222"
    map_grid_bucket = "water-management-reference-222222222222"
    map_grid_key    = "reference/map-grid/waas.tif"
  }

  assert {
    condition     = length(aws_iam_role_policy.lambda_cross_account_read) == 0
    error_message = "A bucket name without icwbt_account_id must grant nothing (the s3:ResourceAccount condition needs the account)."
  }
}

# --- the cross-account grants, exactly ---------------------------------------

run "cross_account_grants_are_exact" {
  command = plan

  variables {
    icwbt_account_id = "222222222222"
    chirps_bucket    = "water-management-mirror-222222222222"
    map_grid_bucket  = "water-management-reference-222222222222"
    map_grid_key     = "reference/map-grid/waas.tif"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.lambda_cross_account_read[0].policy).Statement) == 3
    error_message = "Expected exactly three statements: ChirpsListPrefix, ChirpsRead, MapGridRead."
  }
  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.lambda_cross_account_read[0].policy).Statement :
      s.Effect == "Allow" && s.Condition.StringEquals["s3:ResourceAccount"] == "222222222222"
    ])
    error_message = "Every cross-account statement must be conditioned on s3:ResourceAccount = IC-WBT's account."
  }
  assert {
    condition = sort(flatten([
      for s in jsondecode(aws_iam_role_policy.lambda_cross_account_read[0].policy).Statement : s.Action
      ])) == sort([
      "s3:GetObject", "s3:GetObject", "s3:ListBucket",
    ])
    error_message = "Only s3:GetObject (twice) and s3:ListBucket (once) may be granted: no write, delete or wildcard."
  }
  assert {
    condition = one([
      for s in jsondecode(aws_iam_role_policy.lambda_cross_account_read[0].policy).Statement : s.Resource if s.Sid == "ChirpsRead"
      ]) == [
      "arn:aws:s3:::water-management-mirror-222222222222/rnl/*",
      "arn:aws:s3:::water-management-mirror-222222222222/zarr.json",
    ]
    error_message = "ChirpsRead must cover rnl/* and the root zarr.json only."
  }
  assert {
    condition = one([
      for s in jsondecode(aws_iam_role_policy.lambda_cross_account_read[0].policy).Statement : s.Condition.StringLike["s3:prefix"] if s.Sid == "ChirpsListPrefix"
    ]) == ["rnl/*"]
    error_message = "ListBucket must be conditioned on s3:prefix rnl/*."
  }
  assert {
    condition = one([
      for s in jsondecode(aws_iam_role_policy.lambda_cross_account_read[0].policy).Statement : s.Resource if s.Sid == "MapGridRead"
    ]) == ["arn:aws:s3:::water-management-reference-222222222222/reference/map-grid/waas.tif"]
    error_message = "MapGridRead must name the one exact key."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["CHIRPS_SOURCE"] == "s3"
    error_message = "CHIRPS_SOURCE must be s3 once the grant exists."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["CHIRPS_BUCKET"] == "water-management-mirror-222222222222"
    error_message = "CHIRPS_BUCKET must be the granted bucket."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["MAP_GRID_SOURCE"] == "s3://water-management-reference-222222222222/reference/map-grid/waas.tif"
    error_message = "MAP_GRID_SOURCE must be the granted object's s3:// URL."
  }
}

run "root_metadata_grant_can_be_dropped" {
  command = plan

  variables {
    icwbt_account_id     = "222222222222"
    chirps_bucket        = "water-management-mirror-222222222222"
    chirps_root_metadata = false
  }

  assert {
    condition = one([
      for s in jsondecode(aws_iam_role_policy.lambda_cross_account_read[0].policy).Statement : s.Resource if s.Sid == "ChirpsRead"
    ]) == ["arn:aws:s3:::water-management-mirror-222222222222/rnl/*"]
    error_message = "With chirps_root_metadata = false, ChirpsRead covers rnl/* only."
  }
}

# --- Lambda cost bounds ------------------------------------------------------

run "lambda_bounds" {
  command = plan

  assert {
    condition     = aws_lambda_function.backend.memory_size >= 1024
    error_message = "The API Lambda needs at least 1024 MB (delineation)."
  }
  assert {
    condition     = aws_lambda_function.backend.timeout == 30
    error_message = "The API Lambda timeout is 30 s."
  }
  assert {
    condition     = aws_lambda_function.backend.reserved_concurrent_executions == 10
    error_message = "Reserved concurrency must be capped (default 10)."
  }
  assert {
    condition     = aws_cloudwatch_log_group.lambda.retention_in_days == 30
    error_message = "Log retention must be set (default 30 days)."
  }
  assert {
    condition     = aws_lambda_function.backend.runtime == "nodejs24.x"
    error_message = "Runtime must be a supported Node (nodejs24.x)."
  }
}

run "memory_below_1024_rejected" {
  command = plan
  variables {
    lambda_memory_mb = 512
  }
  expect_failures = [var.lambda_memory_mb]
}

run "unreserved_concurrency_rejected" {
  command = plan
  variables {
    lambda_reserved_concurrency = -1
  }
  expect_failures = [var.lambda_reserved_concurrency]
}

run "forever_log_retention_rejected" {
  command = plan
  variables {
    lambda_log_retention_days = 0
  }
  expect_failures = [var.lambda_log_retention_days]
}

# --- edge: CSP, /api/*, WAF --------------------------------------------------

run "site_csp_is_strict" {
  command = plan

  assert {
    condition     = strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "connect-src 'self';")
    error_message = "connect-src must be exactly 'self'."
  }
  assert {
    condition     = strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "default-src 'self';")
    error_message = "default-src must be 'self'."
  }
  assert {
    condition     = !strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "unsafe-eval")
    error_message = "No 'unsafe-eval'."
  }
  assert {
    condition     = !can(regex("style-src[^;]*'unsafe-inline'", aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy))
    error_message = "style-src must not allow 'unsafe-inline' (hash the attribute in csp.json instead)."
  }
  assert {
    condition     = strcontains(aws_cloudfront_response_headers_policy.site.security_headers_config[0].content_security_policy[0].content_security_policy, "frame-ancestors 'none'")
    error_message = "frame-ancestors must be 'none'."
  }
  assert {
    condition     = startswith(aws_cloudfront_response_headers_policy.api.security_headers_config[0].content_security_policy[0].content_security_policy, "default-src 'none'")
    error_message = "The API's CSP must start with default-src 'none'."
  }
}

run "api_behaviour" {
  command = plan

  assert {
    condition     = one([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : b.cache_policy_id if b.path_pattern == "/api/*"]) == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    error_message = "/api/* must use Managed-CachingDisabled."
  }
  assert {
    condition     = one([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : b.target_origin_id if b.path_pattern == "/api/*"]) == "lambda-api"
    error_message = "/api/* must go to the Lambda origin."
  }
  assert {
    condition     = length(aws_cloudfront_distribution.frontend.custom_error_response) == 0
    error_message = "No custom_error_response: it would replace the API's JSON errors with HTML."
  }
  assert {
    condition     = one([for o in aws_cloudfront_distribution.frontend.origin : o.custom_origin_config[0].origin_read_timeout if o.origin_id == "lambda-api"]) == 30
    error_message = "The API origin's read timeout must match the Lambda timeout."
  }
}

run "waf_rate_limits_api" {
  command = plan

  assert {
    condition = one([
      for r in aws_wafv2_web_acl.frontend.rule :
      r.statement[0].rate_based_statement[0].scope_down_statement[0].byte_match_statement[0].search_string
      if r.name == "RateLimitApiPerIP"
    ]) == "/api/"
    error_message = "The API rate rule must be scoped to /api/."
  }
  assert {
    condition     = one([for r in aws_wafv2_web_acl.frontend.rule : r.statement[0].rate_based_statement[0].limit if r.name == "RateLimitApiPerIP"]) == 300
    error_message = "The API rate limit defaults to 300 per IP per 5 minutes."
  }
}

run "site_limit_below_api_limit_rejected" {
  command = plan
  variables {
    waf_api_rate_limit_per_ip  = 500
    waf_site_rate_limit_per_ip = 400
  }
  expect_failures = [aws_wafv2_web_acl.frontend]
}
