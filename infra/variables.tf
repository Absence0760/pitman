# ----------------------------------------------------------------------------
# Account, region, domain
# ----------------------------------------------------------------------------

variable "aws_region" {
  description = <<-EOT
    Primary region: the API Lambda, the site bucket, the user table, SES and
    their alarms. af-south-1 (D-6), beside IC-WBT's buckets, so the CHIRPS and
    MAP-grid reads stay in-region. An opt-in region: enable it in the account
    first.

    The privacy notice tells users their data (the user list, sign-in codes,
    the audit rows) is stored in South Africa, so any other region is refused
    unless data_outside_south_africa is set (A-AUTH-6, copied from WM
    infra/variables.tf).
  EOT
  type        = string
  default     = "af-south-1"

  validation {
    condition     = var.aws_region == "af-south-1" || var.data_outside_south_africa
    error_message = "The privacy notice says the user list is stored in South Africa (af-south-1). To deploy elsewhere, rewrite the notice first, then set data_outside_south_africa = true (A-AUTH-6)."
  }
}

variable "data_outside_south_africa" {
  description = "Deliberately host outside af-south-1 (Cape Town). Allowed only with the privacy notice rewritten to say where the user list is stored (POPIA s72; A-AUTH-6)."
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "The site's host name. Its Route 53 zone is the delegated child zone the estate bootstrap (new-project-account.sh) created; this stack looks it up by name and adds records to it, never creates it."
  type        = string
  default     = "pitman.jaredhoward.com"
}

variable "github_repo" {
  description = "GitHub repository, owner/name. A tag only (the deploy role's trust policy is the bootstrap's)."
  type        = string
  default     = "Absence0760/pitman"
}

variable "bootstrap_slug" {
  description = "Slug new-project-account.sh was run with. oidc.tf looks up the deploy role `<slug>-deploy`; a mismatch fails the plan with \"role not found\"."
  type        = string
  default     = "pitman"
}

# ----------------------------------------------------------------------------
# API Lambda
# ----------------------------------------------------------------------------

variable "lambda_memory_mb" {
  description = <<-EOT
    API Lambda memory. At least 1024 (docs/data.md § Backend: delineation: up
    to ~460 MB at the 3 072-cell window); CPU scales with it, so the CHIRPS
    block decode is faster too. At most 2048, and memory x
    lambda_reserved_concurrency at most 10 240 MB (checked on that variable),
    so every copy busy for a month costs at most
    10 GB x 2 592 000 s x $0.00001768 (af-south-1 arm64) = $458.27 before the
    breaker (breaker.tf) stops it; the old 10 240 MB x 50 bound was $22 913.
  EOT
  type        = number
  default     = 1024
  validation {
    condition     = var.lambda_memory_mb >= 1024 && var.lambda_memory_mb <= 2048
    error_message = "lambda_memory_mb must be 1024-2048: at least 1024 for delineation, at most 2048 so the concurrency x memory ceiling stays near $460 a month."
  }
}

variable "lambda_timeout_seconds" {
  description = "API Lambda timeout. 30 s: delineation keeps a 20 s budget under it, and CloudFront's origin read timeout (30 s, s3_cloudfront.tf) is the same, so the viewer never waits on a request the function has given up on."
  type        = number
  default     = 30
  validation {
    condition     = var.lambda_timeout_seconds >= 25 && var.lambda_timeout_seconds <= 30
    error_message = "lambda_timeout_seconds must be 25-30: delineation needs a 20 s budget plus headroom, and CloudFront stops waiting at 30 s."
  }
}

variable "lambda_reserved_concurrency" {
  description = <<-EOT
    Reserved concurrency of the API Lambda: the most copies that can run at
    once, which caps worst-case spend (concurrency x memory x seconds). Lambda
    keeps 10 unreserved and the breaker reserves 1 (breaker.tf), so the
    account's concurrency quota must be at least this + 11; a new account's
    quota can be 10, so ask Service Quotas for more first
    (docs/deployment.md).

    At least 5: the two queues' event source mappings (mail events, ses.tf;
    sign-in mail, mail_queue.tf) each run up to 2 batches inside this cap,
    and AWS recommends reserved concurrency of 5 or more for an SQS trigger
    (below the mapping's maximum, Lambda throttles the queue's polls). At
    most 10, and this x lambda_memory_mb at most 10 240 MB: every copy busy
    for a month is then at most 10 GB x 2 592 000 s x $0.00001768 =
    $458.27, and Lambda's request-rate quota (10 x this a second) at most
    259.2 M requests x $0.27 per million = $69.98. The breaker (breaker.tf)
    stops sustained use long before either.
  EOT
  type        = number
  default     = 10
  validation {
    condition     = var.lambda_reserved_concurrency >= 5 && var.lambda_reserved_concurrency <= 10
    error_message = "lambda_reserved_concurrency must be 5-10: at least 5 for the SQS triggers (AWS's minimum recommendation, above the two mappings' combined maximum concurrency of 4), at most 10 for the cost ceiling, and there is deliberately no 'unreserved' (-1) option: the cap is the cost control."
  }
  validation {
    condition     = var.lambda_reserved_concurrency * var.lambda_memory_mb <= 10240
    error_message = "lambda_reserved_concurrency x lambda_memory_mb must be at most 10 240 MB (10 copies of 1 GB, or 5 of 2 GB): about $458 a month with every copy busy."
  }
}

variable "lambda_log_retention_days" {
  description = "CloudWatch log retention for the API Lambda, in days."
  type        = number
  default     = 30
  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365], var.lambda_log_retention_days)
    error_message = "lambda_log_retention_days must be one of CloudWatch's values up to a year (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365); never 0 (forever)."
  }
}

# ----------------------------------------------------------------------------
# IC-WBT's buckets (cross-account read, docs/data.md § Cross-account access)
#
# Empty values (the defaults) grant nothing and leave the matching Lambda
# env var empty, so the stack applies before IC-WBT's side (4.1) exists. The
# bucket names are not secrets but they embed IC-WBT's account ID; keep them
# in the gitignored terraform.tfvars, not in this file.
# ----------------------------------------------------------------------------

variable "icwbt_account_id" {
  description = "IC-WBT's AWS account ID. Every cross-account statement carries `s3:ResourceAccount = this`, so a same-named bucket in any other account is never readable."
  type        = string
  default     = ""
  validation {
    condition     = var.icwbt_account_id == "" || can(regex("^[0-9]{12}$", var.icwbt_account_id))
    error_message = "icwbt_account_id must be empty or a 12-digit account ID."
  }
}

variable "icwbt_region" {
  description = "Region of IC-WBT's buckets: the Lambda's DATA_REGION, the S3 client's region for every cross-account read. af-south-1 (docs/data.md § Cross-account access, 'Region'), and independent of aws_region, so moving Pitman (data_outside_south_africa) never points the reads at the wrong region."
  type        = string
  default     = "af-south-1"
  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.icwbt_region))
    error_message = "icwbt_region must be an AWS region name, such as af-south-1."
  }
}

variable "chirps_bucket" {
  description = "IC-WBT's mirror bucket (water-management-mirror-<id>), holding the CHIRPS Zarr store under chirps_prefix. Empty: no CHIRPS grant, CHIRPS_BUCKET empty."
  type        = string
  default     = ""
}

variable "chirps_prefix" {
  description = "Prefix of the CHIRPS monthly store in the mirror bucket. The only prefix the Lambda may read or list there (rows 1-2)."
  type        = string
  default     = "rnl"
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9_-]*$", var.chirps_prefix))
    error_message = "chirps_prefix is one path segment (no slashes, no wildcards)."
  }
}

variable "chirps_root_metadata" {
  description = "Also grant GetObject on the bucket-root zarr.json (Zarr v3 group metadata). Off: the reader opens `<prefix>/zarr.json` and never the root group (backend/src/chirps/mirror/arrays.ts; store.test.ts pins it), so the grant would only widen the cross-account read by an object nobody reads. Turn on only if a future reader opens the root group."
  type        = bool
  default     = false
}

variable "map_grid_bucket" {
  description = "IC-WBT's reference bucket (water-management-reference-<id>) holding the MAP grid (row 5). Empty: no grant, MAP_GRID_SOURCE empty."
  type        = string
  default     = ""
}

variable "map_grid_key" {
  description = "Exact key of the MAP-grid file in map_grid_bucket (reference/map-grid/<file>). One object, never a prefix."
  type        = string
  default     = ""
  validation {
    condition     = !strcontains(var.map_grid_key, "*")
    error_message = "map_grid_key is one exact key; wildcards are not allowed."
  }
}

# ----------------------------------------------------------------------------
# Users, sign-in and mail (issue #28, A-AUTH-4/7)
# ----------------------------------------------------------------------------

variable "audit_retention_months" {
  description = "How long audit rows live in the user table before their TTL removes them. auth-kit sets it (its own constant); this records it beside the table (a tag) for the privacy notice and the docs, and must match auth-kit. 24 months, as EWR chose (A-AUTH-4)."
  type        = number
  default     = 24
  validation {
    condition     = var.audit_retention_months == 24
    error_message = "audit_retention_months is auth-kit's constant (24). Change it in auth-kit and the privacy notice first, then here."
  }
}

variable "dmarc_policy" {
  description = "DMARC policy on _dmarc.<domain_name>. none to start (A-AUTH-7); DKIM and the send. MAIL FROM both align, so it can be tightened to quarantine or reject later without losing mail."
  type        = string
  default     = "none"
  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "dmarc_policy must be none, quarantine or reject."
  }
}

variable "dmarc_report_email" {
  description = "Optional rua= address for DMARC aggregate reports. Empty: no reports requested. Must accept reports for this domain (an address on another domain needs that domain's _report._dmarc authorisation record)."
  type        = string
  default     = ""
}

# ----------------------------------------------------------------------------
# Edge: WAF and cost alarms
# ----------------------------------------------------------------------------

variable "waf_api_rate_limit_per_ip" {
  description = "WAF rate limit on /api/*: requests per IP per 5-minute window. Each is a Lambda invocation that may fan out to at most 720 S3 GETs on IC-WBT's bill (16 chunks, R4-D6), and at most 144,000 CHIRPS GETs per user per day (R4-D7); a hydrologist extending a network makes a handful. AWS minimum 100."
  type        = number
  default     = 300
  validation {
    condition     = var.waf_api_rate_limit_per_ip >= 100
    error_message = "AWS WAF's rate-based rule minimum is 100 per 5-minute window."
  }
}

variable "auth_waf_rate_limit_per_ip" {
  description = "WAF rate limit on /api/auth/* except /api/auth/me (which every page load calls, so it counts under waf_api_rate_limit_per_ip instead): requests per IP per 5-minute window (A-AUTH-9). The sign-in flow is two or three calls; auth-kit's own per-address limits are the real bound, this one slows one source guessing codes against many addresses. AWS minimum 100."
  type        = number
  default     = 100
  validation {
    condition     = var.auth_waf_rate_limit_per_ip >= 100
    error_message = "AWS WAF's rate-based rule minimum is 100 per 5-minute window."
  }
}

variable "waf_site_rate_limit_per_ip" {
  description = "WAF backstop on every path: requests per IP per 5-minute window. The static site is edge-cached, so this only bounds a single-source flood. At least waf_api_rate_limit_per_ip."
  type        = number
  default     = 2000
  validation {
    condition     = var.waf_site_rate_limit_per_ip >= 100
    error_message = "AWS WAF's rate-based rule minimum is 100 per 5-minute window."
  }
}

variable "budget_monthly_usd" {
  description = "Monthly cost budget in USD; email + SNS at forecasted 100 %, actual 80 % and actual 100 % (80 %, not 50 %: the fixed baseline is about $12.80, about $14.70 with VAT, so a 50 % line on $25 would fire every month and teach the operator to ignore it). Credits and refunds are excluded, so new-account credits can't hide a runaway. Must be above 0; 0 is accepted only with no_budget_acknowledged = true (until IAM access to billing information is enabled on the account, docs/deployment.md § First deploy)."
  type        = number
  default     = 25
  validation {
    condition     = var.budget_monthly_usd >= 0
    error_message = "budget_monthly_usd can't be negative."
  }
  validation {
    condition     = var.budget_monthly_usd > 0 || var.no_budget_acknowledged
    error_message = "budget_monthly_usd = 0 creates no budget, so nothing but the CloudWatch alarms watches spend. Set a budget, or (only until IAM access to billing information is enabled on the account) set no_budget_acknowledged = true as well."
  }
}

variable "no_budget_acknowledged" {
  description = "The explicit opt-out that lets budget_monthly_usd = 0 apply: the account has no IAM access to billing information yet, so aws_budgets_budget would fail with AccessDeniedException. Turn it back off, with a real budget, as soon as billing access is on (docs/deployment.md § First deploy)."
  type        = bool
  default     = false
}

variable "alert_email" {
  description = "Email subscribed to both alert topics (budget, Lambda, CloudFront, WAF alarms) and sent the budget directly. Required: with no address every alarm and the budget notify nobody. A real mailbox, never a reserved example domain (example.com/.org/.net, .example, .test, .invalid, .localhost); AWS emails a confirmation link per topic the first time, and both must be clicked."
  type        = string
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be an email address: every alarm and the budget notify it."
  }
  validation {
    condition     = !can(regex("(?i)@(.*\\.)?(example\\.(com|org|net)|example|test|invalid|localhost)$", var.alert_email))
    error_message = "alert_email is a placeholder on a reserved example domain; alarms sent there reach nobody. Use a real mailbox."
  }
}

variable "lambda_invocations_alarm_per_hour" {
  description = "Alarm when the API Lambda is invoked faster than this many times an hour, measured over 5 minutes (threshold = this / 12, rounded up, per 5-minute sum): the early sign of a flood the WAF lets through (spread over many IPs). Mail only; the breaker (breaker.tf) is what stops it."
  type        = number
  default     = 2000
  validation {
    condition     = var.lambda_invocations_alarm_per_hour >= 12
    error_message = "lambda_invocations_alarm_per_hour must be at least 12 (one invocation per 5-minute window)."
  }
}

variable "cloudfront_requests_alarm_per_hour" {
  description = <<-EOT
    Alarm when CloudFront serves requests faster than this many an hour,
    measured over 5 minutes (threshold = this / 12, rounded up, per 5-minute
    sum; AWS/CloudFront Requests, us-east-1). The edge is the one spend path
    no cap bounds: a flood spread over many IPs stays under the per-IP WAF
    rules and is served from cache without touching the Lambda, at $1.90 per
    million requests (CloudFront $1.20 at South African and Indian edges +
    WAF $0.60 + CloudFront Functions $0.10). An invite-only tool's handful of
    users make a few thousand an hour. Just under 20 000 an hour all month is
    14.4 M requests x $1.90 = $27.36 that passes unseen (50 000 an hour let
    $68.40 through).
  EOT
  type        = number
  default     = 20000
  validation {
    condition     = var.cloudfront_requests_alarm_per_hour >= 12
    error_message = "cloudfront_requests_alarm_per_hour must be at least 12 (one request per 5-minute window)."
  }
}

variable "cloudfront_gb_alarm_per_hour" {
  description = <<-EOT
    Alarm when CloudFront sends GB to viewers faster than this many an hour,
    measured over 5 minutes (threshold = this / 12 per 5-minute sum, in
    bytes; AWS/CloudFront BytesDownloaded, us-east-1). The whole site is a
    few MB per cold visit. Just under 1 GB an hour all month is 720 GB x
    $0.110 (South African egress) = $79.20 that passes unseen (5 GB an hour
    let $396 through), before CloudFront's always-free 1 TB a month. Revisit
    it when /tiles/* lands (docs/data.md row 6).
  EOT
  type        = number
  default     = 1
  validation {
    condition     = var.cloudfront_gb_alarm_per_hour > 0
    error_message = "cloudfront_gb_alarm_per_hour must be above 0."
  }
}

variable "route53_queries_alarm_per_hour" {
  description = <<-EOT
    Alarm when the site's hosted zone answers DNS queries faster than this
    many an hour, measured over 5 minutes (threshold = this / 12, rounded
    up, per 5-minute sum; AWS/Route53 DNSQueries, us-east-1). Queries for
    names other than the CloudFront aliases (a random-subdomain flood, the
    SES records) are billed at $0.40 per million and nothing caps them.
    Resolvers cache the records, so a handful of users make a few hundred
    an hour. Just under 20 000 an hour all month is 14.4 M x $0.40 = $5.76
    unseen.
  EOT
  type        = number
  default     = 20000
  validation {
    condition     = var.route53_queries_alarm_per_hour >= 12
    error_message = "route53_queries_alarm_per_hour must be at least 12 (one query per 5-minute window)."
  }
}

# ----------------------------------------------------------------------------
# Spend circuit breaker (breaker.tf, R4-I7)
# ----------------------------------------------------------------------------

variable "breaker_concurrency_threshold" {
  description = "Trip the breaker (API reserved concurrency to 0) when the API Lambda's ConcurrentExecutions reaches this many copies in each of 3 consecutive 5-minute periods. A handful of users run one request at a time each, and the two queue mappings hold at most 4 copies for seconds; at saturation (10 copies) it trips in about 15 minutes, having spent 10 x 900 s x 1 GB x $0.00001768 = $0.16. At least 4 (the mappings alone can reach 4), and no more than lambda_reserved_concurrency (the metric can't exceed it, so the alarm would never fire)."
  type        = number
  default     = 6
  validation {
    condition     = var.breaker_concurrency_threshold >= 4 && var.breaker_concurrency_threshold <= var.lambda_reserved_concurrency
    error_message = "breaker_concurrency_threshold must be at least 4 (the queue mappings alone can reach 4) and at most lambda_reserved_concurrency (above it the alarm can never fire)."
  }
}

variable "breaker_duration_ms_per_hour" {
  description = <<-EOT
    Trip the breaker when the API Lambda's billed Duration over a clock hour
    exceeds this many milliseconds. 7 200 000 = 2 copies busy the whole hour,
    or 288 requests of 25 s (the longest CHIRPS read) in one hour; a
    hydrologist makes a handful. It catches what the concurrency trip misses
    (5 copies held for good, or 10 pulsed on and off), within 1-2 hours.
    Below it, compute averages under threshold / 3 600 000 copies: at the
    default 1 GB, 2 x 1 GB x 2 592 000 s x $0.00001768 = $91.66 a month at
    most. Validated so that ceiling holds at any allowed memory
    (this x lambda_memory_mb / 1024 at most 7 200 000), and at least
    3 600 000 (one copy-hour an hour), below which ordinary use could trip
    it.
  EOT
  type        = number
  default     = 7200000
  validation {
    condition     = var.breaker_duration_ms_per_hour >= 3600000 && var.breaker_duration_ms_per_hour * var.lambda_memory_mb / 1024 <= 7200000
    error_message = "breaker_duration_ms_per_hour must be at least 3 600 000 (one copy-hour an hour) and, scaled by lambda_memory_mb / 1024, at most 7 200 000 (2 GB-hours an hour, about $92 a month)."
  }
}

variable "breaker_invocations_per_5_minutes" {
  description = <<-EOT
    Trip the breaker when the API Lambda is invoked more than this many
    times in each of 3 consecutive 5-minute periods: the flood of fast
    requests the Duration trip can't see. 3 000 is 10 a second for 15
    minutes; the frontend never polls, so a handful of users make tens per
    5 minutes. Below it, requests cost at most 10 x 2 592 000 = 25.92 M x
    $0.27/M = $7.00 a month, plus ~400 B of log line each, 10.4 GB x $0.678
    + storage = ~$7.40. Validated 600-6 000 (2-20 a second): lower could trip
    on a busy afternoon, higher lets $14 of requests and $15 of logs through
    a month and
    nears Lambda's own limit (10 x lambda_reserved_concurrency a second).
  EOT
  type        = number
  default     = 3000
  validation {
    condition     = var.breaker_invocations_per_5_minutes >= 600 && var.breaker_invocations_per_5_minutes <= 6000
    error_message = "breaker_invocations_per_5_minutes must be 600-6 000 (2-20 requests a second sustained)."
  }
}

# ----------------------------------------------------------------------------
# Cape Farm Mapper (D3, R7-C9)
# ----------------------------------------------------------------------------

variable "cfm_token" {
  description = <<-EOT
    The operator's Cape Farm Mapper token (D3), passed to the Lambda as
    CFM_TOKEN. Empty (the default): CFM_SOURCE stays empty and /cfm/* answers
    503 "not configured". It comes from the operator's sops file
    (infra-secrets/pitman/prod.sops.yaml) by decrypt-to-tfvars, never from a
    file in this repo; Terraform owns the function's environment, so a token
    set by hand would be wiped by the next apply (docs/deployment.md §
    Lambda environment). It lands in state and the function's configuration,
    like the sign-in keys; issue #22 decision 15 (Secrets Manager, R7-C9) is
    still open and would replace this.
  EOT
  type        = string
  default     = ""
  sensitive   = true
  validation {
    condition     = var.cfm_token == "" || var.cfm_crops_layer_url != ""
    error_message = "cfm_token is set but cfm_crops_layer_url is not: the backend needs both (backend/src/cfm/source.ts)."
  }
}

variable "cfm_crops_layer_url" {
  description = "Cape Farm Mapper crops layer URL (CFM_CROPS_LAYER_URL; question 3 of docs/data.md § Cape Farm Mapper). Required with cfm_token; https only, because the token travels with it."
  type        = string
  default     = ""
  validation {
    condition     = var.cfm_crops_layer_url == "" || can(regex("^https://[^/\\s]+/\\S+$", var.cfm_crops_layer_url))
    error_message = "cfm_crops_layer_url must be empty or an https URL with a path."
  }
}

variable "cfm_dams_layer_url" {
  description = "Cape Farm Mapper dams layer URL (CFM_DAMS_LAYER_URL), optional until question 3 says a dams layer exists. https only."
  type        = string
  default     = ""
  validation {
    condition     = var.cfm_dams_layer_url == "" || can(regex("^https://[^/\\s]+/\\S+$", var.cfm_dams_layer_url))
    error_message = "cfm_dams_layer_url must be empty or an https URL with a path."
  }
}
