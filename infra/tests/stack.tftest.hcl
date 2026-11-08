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

# alert_email is required (variables.tf); a real-looking address so every run
# plans. Runs that test its validation override it.
variables {
  alert_email = "alerts@pitman.jaredhoward.com"
}

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
    ]) == ["arn:aws:s3:::water-management-mirror-222222222222/rnl/*"]
    error_message = "ChirpsRead must cover rnl/* only by default: the reader never opens the root zarr.json (R4-I11)."
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

run "root_metadata_grant_only_when_asked" {
  command = plan

  variables {
    icwbt_account_id     = "222222222222"
    chirps_bucket        = "water-management-mirror-222222222222"
    chirps_root_metadata = true
  }

  assert {
    condition = one([
      for s in jsondecode(aws_iam_role_policy.lambda_cross_account_read[0].policy).Statement : s.Resource if s.Sid == "ChirpsRead"
      ]) == [
      "arn:aws:s3:::water-management-mirror-222222222222/rnl/*",
      "arn:aws:s3:::water-management-mirror-222222222222/zarr.json",
    ]
    error_message = "With chirps_root_metadata = true, ChirpsRead adds the root zarr.json and nothing else."
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

run "memory_above_2048_rejected" {
  command = plan
  variables {
    lambda_memory_mb = 3008
  }
  expect_failures = [var.lambda_memory_mb]
}

run "concurrency_above_10_rejected" {
  command = plan
  variables {
    lambda_reserved_concurrency   = 11
    breaker_concurrency_threshold = 6
  }
  expect_failures = [var.lambda_reserved_concurrency]
}

run "concurrency_times_memory_above_10_gb_rejected" {
  command = plan
  variables {
    lambda_memory_mb             = 2048
    lambda_reserved_concurrency  = 6
    breaker_duration_ms_per_hour = 3600000
  }
  expect_failures = [var.lambda_reserved_concurrency]
}

run "five_copies_of_2_gb_accepted" {
  command = plan
  variables {
    lambda_memory_mb              = 2048
    lambda_reserved_concurrency   = 5
    breaker_concurrency_threshold = 5
    breaker_duration_ms_per_hour  = 3600000
  }
  assert {
    condition     = aws_lambda_function.backend.memory_size * aws_lambda_function.backend.reserved_concurrent_executions == 10240
    error_message = "5 x 2 GB is the other end of the 10 GB ceiling."
  }
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
    condition     = strcontains(local.csp_site, "connect-src 'self';")
    error_message = "connect-src must be exactly 'self'."
  }
  assert {
    condition     = strcontains(local.csp_site, "default-src 'self';")
    error_message = "default-src must be 'self'."
  }
  assert {
    condition     = !strcontains(local.csp_site, "unsafe-eval")
    error_message = "No 'unsafe-eval'."
  }
  assert {
    condition     = !can(regex("style-src[^;]*'unsafe-inline'", local.csp_site))
    error_message = "style-src must not allow 'unsafe-inline' (hash the attribute in csp.json instead)."
  }
  assert {
    condition     = strcontains(local.csp_site, "frame-ancestors 'none'")
    error_message = "frame-ancestors must be 'none'."
  }
  assert {
    condition     = startswith(local.csp_api, "default-src 'none'")
    error_message = "The API's CSP must start with default-src 'none'."
  }
}

# R4-I14: the security headers come from two viewer-response CloudFront
# Functions, one per behaviour, rendered from one template with that
# behaviour's CSP from csp.json. The JS itself (the exact header set) is
# tested by infra/scripts/cloudfront-functions.test.mjs.
run "security_headers_functions" {
  command = plan

  override_resource {
    target          = aws_cloudfront_function.site_headers
    override_during = plan
    values = {
      arn = "arn:aws:cloudfront::111111111111:function/pitman-site-headers"
    }
  }
  override_resource {
    target          = aws_cloudfront_function.api_headers
    override_during = plan
    values = {
      arn = "arn:aws:cloudfront::111111111111:function/pitman-api-headers"
    }
  }
  override_resource {
    target          = aws_cloudfront_function.spa_rewrite
    override_during = plan
    values = {
      arn = "arn:aws:cloudfront::111111111111:function/pitman-spa-rewrite"
    }
  }
  override_resource {
    target          = aws_cloudfront_function.api_strip_prefix
    override_during = plan
    values = {
      arn = "arn:aws:cloudfront::111111111111:function/pitman-api-strip-prefix"
    }
  }

  assert {
    condition     = strcontains(aws_cloudfront_function.site_headers.code, "var CSP = ${jsonencode(local.csp_site)};") && strcontains(aws_cloudfront_function.site_headers.code, "var BEHAVIOUR = \"site\";")
    error_message = "The site function carries csp.json's site CSP and the site behaviour."
  }
  assert {
    condition     = strcontains(aws_cloudfront_function.api_headers.code, "var CSP = ${jsonencode(local.csp_api)};") && strcontains(aws_cloudfront_function.api_headers.code, "var BEHAVIOUR = \"api\";")
    error_message = "The API function carries csp.json's api CSP (default-src 'none') and the api behaviour."
  }
  assert {
    condition = alltrue([
      for f in [aws_cloudfront_function.site_headers, aws_cloudfront_function.api_headers] :
      f.runtime == "cloudfront-js-2.0" && f.publish && length(f.code) < 10240 && !strcontains(f.code, "$${")
    ])
    error_message = "Both header functions: cloudfront-js-2.0, published, under CloudFront Functions' 10 KB limit, every template placeholder rendered."
  }
  assert {
    condition     = aws_cloudfront_function.site_headers.name != aws_cloudfront_function.api_headers.name
    error_message = "One function per behaviour, never shared (the flat-rate plans forbid sharing a function between distributions)."
  }
  assert {
    condition = (
      sort([for a in aws_cloudfront_distribution.frontend.default_cache_behavior[0].function_association : "${a.event_type} ${a.function_arn}"]) ==
      sort(["viewer-request arn:aws:cloudfront::111111111111:function/pitman-spa-rewrite", "viewer-response arn:aws:cloudfront::111111111111:function/pitman-site-headers"])
    )
    error_message = "The default behaviour: spa_rewrite on viewer request, the site headers on viewer response."
  }
  assert {
    condition = (
      sort(flatten([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : [for a in b.function_association : "${a.event_type} ${a.function_arn}"] if b.path_pattern == "/api/*"])) ==
      sort(["viewer-request arn:aws:cloudfront::111111111111:function/pitman-api-strip-prefix", "viewer-response arn:aws:cloudfront::111111111111:function/pitman-api-headers"])
    )
    error_message = "/api/*: the prefix strip on viewer request, the API headers on viewer response."
  }
  assert {
    condition = (
      aws_cloudfront_distribution.frontend.default_cache_behavior[0].response_headers_policy_id == null
      && alltrue([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : b.response_headers_policy_id == null])
    )
    error_message = "No response headers policy on any behaviour: a custom one needs the Business flat-rate plan (R4-I14)."
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

# Issue #33 (R4-I6): the Function URL admits only CloudFront's signed
# requests for this distribution, so a direct call is refused before it runs.
run "api_origin_access_control" {
  command = plan

  # Known at plan, so the wiring between them can be compared.
  override_resource {
    target          = aws_cloudfront_distribution.frontend
    override_during = plan
    values = {
      arn = "arn:aws:cloudfront::111111111111:distribution/E2EXAMPLE"
    }
  }
  override_resource {
    target          = aws_cloudfront_origin_access_control.api
    override_during = plan
    values = {
      id = "E3APIOAC"
    }
  }

  assert {
    condition     = aws_lambda_function_url.backend.authorization_type == "AWS_IAM"
    error_message = "The Function URL must be AWS_IAM: NONE lets a caller that skips CloudFront run (and bill) the function."
  }
  assert {
    condition     = aws_cloudfront_origin_access_control.api.origin_access_control_origin_type == "lambda"
    error_message = "The API's OAC must be of origin type lambda."
  }
  assert {
    condition     = aws_cloudfront_origin_access_control.api.signing_behavior == "always" && aws_cloudfront_origin_access_control.api.signing_protocol == "sigv4"
    error_message = "The API's OAC must always sign (sigv4): never would leave CloudFront unable to reach an AWS_IAM URL, no-override would pass a viewer's Authorization through."
  }
  assert {
    condition     = one([for o in aws_cloudfront_distribution.frontend.origin : o.origin_access_control_id if o.origin_id == "lambda-api"]) == "E3APIOAC"
    error_message = "The lambda-api origin must use the API's OAC."
  }
  assert {
    condition     = one([for o in aws_cloudfront_distribution.frontend.origin : o.custom_origin_config[0].origin_protocol_policy if o.origin_id == "lambda-api"]) == "https-only"
    error_message = "A Lambda OAC origin must be https-only."
  }
  assert {
    condition     = one([for o in aws_cloudfront_distribution.frontend.origin : length([for h in o.custom_header : h if h.name == "X-CloudFront-Shared-Secret"]) if o.origin_id == "lambda-api"]) == 1
    error_message = "The shared-secret header stays as the second layer behind the OAC."
  }
  assert {
    condition     = one([for b in aws_cloudfront_distribution.frontend.ordered_cache_behavior : b.origin_request_policy_id if b.path_pattern == "/api/*"]) == "b689b0a8-53d0-40ab-baf2-68738e2966ac"
    error_message = "/api/* must use Managed-AllViewerExceptHostHeader: a forwarded viewer Host breaks the OAC signature."
  }
  # Both actions, CloudFront's service principal, this distribution only.
  assert {
    condition = (
      aws_lambda_permission.cloudfront_invoke_url.action == "lambda:InvokeFunctionUrl"
      && aws_lambda_permission.cloudfront_invoke_url.principal == "cloudfront.amazonaws.com"
      && aws_lambda_permission.cloudfront_invoke_url.function_url_auth_type == "AWS_IAM"
      && aws_lambda_permission.cloudfront_invoke_url.function_name == aws_lambda_function.backend.function_name
    )
    error_message = "CloudFront needs lambda:InvokeFunctionUrl on the backend, for an AWS_IAM URL."
  }
  assert {
    condition = (
      aws_lambda_permission.cloudfront_invoke_function.action == "lambda:InvokeFunction"
      && aws_lambda_permission.cloudfront_invoke_function.principal == "cloudfront.amazonaws.com"
      && aws_lambda_permission.cloudfront_invoke_function.function_name == aws_lambda_function.backend.function_name
    )
    error_message = "Since October 2025 a Function URL also needs lambda:InvokeFunction for CloudFront."
  }
  assert {
    condition     = aws_lambda_permission.cloudfront_invoke_url.source_arn == "arn:aws:cloudfront::111111111111:distribution/E2EXAMPLE" && aws_lambda_permission.cloudfront_invoke_function.source_arn == "arn:aws:cloudfront::111111111111:distribution/E2EXAMPLE"
    error_message = "Both permissions must be scoped to this distribution (source_arn), or any distribution could invoke the URL."
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

# --- the deploy role's policy (oidc.tf) ----------------------------------------

run "deploy_policy_is_exact" {
  command = plan

  override_resource {
    target          = aws_s3_bucket.frontend
    override_during = plan
    values = {
      arn = "arn:aws:s3:::pitman-frontend-111111111111"
    }
  }
  override_resource {
    target          = aws_cloudfront_distribution.frontend
    override_during = plan
    values = {
      arn = "arn:aws:cloudfront::111111111111:distribution/E2EXAMPLE"
    }
  }
  override_resource {
    target          = aws_lambda_function.backend
    override_during = plan
    values = {
      arn = "arn:aws:lambda:af-south-1:111111111111:function:pitman-backend"
    }
  }

  assert {
    condition = jsonencode({ for s in data.aws_iam_policy_document.github_deploy.statement : s.sid => sort(s.actions) }) == jsonencode({
      FrontendBucketWrite    = ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"]
      FrontendBucketList     = ["s3:ListBucket"]
      CloudFrontInvalidation = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
      LambdaUpdate           = ["lambda:GetFunctionConfiguration", "lambda:UpdateFunctionCode"]
    })
    error_message = "The deploy role syncs the site bucket, invalidates the distribution and replaces the function's code, nothing else (no GetFunction, no concurrency or configuration change)."
  }
  assert {
    condition     = alltrue([for s in data.aws_iam_policy_document.github_deploy.statement : s.effect == null || s.effect == "Allow"])
    error_message = "Allow statements only."
  }
  assert {
    condition = alltrue(flatten([
      for s in data.aws_iam_policy_document.github_deploy.statement : [for r in s.resources : !strcontains(r, "*") || endswith(r, "/*")]
    ]))
    error_message = "No wildcard resource other than the site bucket's objects."
  }
}

# --- the site bucket and the edge ---------------------------------------------

run "site_bucket_is_private_and_tls_only" {
  command = plan

  override_resource {
    target          = aws_cloudfront_distribution.frontend
    override_during = plan
    values = {
      arn = "arn:aws:cloudfront::111111111111:distribution/E2EXAMPLE"
    }
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.frontend.block_public_acls &&
      aws_s3_bucket_public_access_block.frontend.block_public_policy &&
      aws_s3_bucket_public_access_block.frontend.ignore_public_acls &&
      aws_s3_bucket_public_access_block.frontend.restrict_public_buckets
    )
    error_message = "All four public-access-block flags stay on."
  }
  assert {
    condition = one([
      for s in data.aws_iam_policy_document.frontend_bucket_policy.statement : s.actions if s.sid == "AllowCloudFrontServicePrincipalRead"
    ]) == toset(["s3:GetObject"])
    error_message = "CloudFront may only GetObject."
  }
  assert {
    condition = jsonencode(flatten([
      for s in data.aws_iam_policy_document.frontend_bucket_policy.statement : [
        for c in s.condition : tolist(c.values) if c.variable == "AWS:SourceArn"
      ] if s.sid == "AllowCloudFrontServicePrincipalRead"
    ])) == jsonencode(["arn:aws:cloudfront::111111111111:distribution/E2EXAMPLE"])
    error_message = "The read is conditioned on this distribution's ARN (OAC)."
  }
  assert {
    condition = one([
      for s in data.aws_iam_policy_document.frontend_bucket_policy.statement :
      s.effect == "Deny" && jsonencode(flatten([for c in s.condition : tolist(c.values) if c.variable == "aws:SecureTransport"])) == jsonencode(["false"])
      if s.sid == "DenyInsecureTransport"
    ])
    error_message = "Every non-TLS request to the bucket is denied."
  }
  assert {
    condition     = aws_cloudfront_distribution.frontend.price_class == "PriceClass_200"
    error_message = "PriceClass_200 (South African and Indian edges; not All)."
  }
  assert {
    condition     = aws_cloudfront_distribution.frontend.viewer_certificate[0].minimum_protocol_version == "TLSv1.2_2021"
    error_message = "Viewers need TLS 1.2 (TLSv1.2_2021) at least."
  }
}
