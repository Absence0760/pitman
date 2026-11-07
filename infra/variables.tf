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
  description = "API Lambda memory. At least 1024 (docs/data.md § Backend: delineation: up to ~460 MB at the 3 072-cell window); CPU scales with it, so the CHIRPS block decode is faster too."
  type        = number
  default     = 1024
  validation {
    condition     = var.lambda_memory_mb >= 1024 && var.lambda_memory_mb <= 10240
    error_message = "lambda_memory_mb must be between 1024 (delineation) and 10240 (Lambda's maximum)."
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
  description = "Reserved concurrency of the API Lambda: the most copies that can run at once, which caps worst-case spend (concurrency x memory x seconds). Lambda keeps 10 unreserved, so the account's concurrency quota must be at least this + 10; a new account's quota can be 10, so ask Service Quotas for more first (docs/deployment.md). At least 5: the two queues' event source mappings (mail events, ses.tf; sign-in mail, mail_queue.tf) each run up to 2 batches inside this cap, and AWS recommends reserved concurrency of 5 or more for an SQS trigger (below the mapping's maximum, Lambda throttles the queue's polls)."
  type        = number
  default     = 10
  validation {
    condition     = var.lambda_reserved_concurrency >= 5 && var.lambda_reserved_concurrency <= 50
    error_message = "lambda_reserved_concurrency must be 5-50: at least 5 for the SQS triggers (AWS's minimum recommendation, above the two mappings' combined maximum concurrency of 4), and there is deliberately no 'unreserved' (-1) option: the cap is the cost control."
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
  description = "Also grant GetObject on the bucket-root zarr.json (Zarr v3 group metadata), if the reader opens the root group (docs/data.md § Cross-account access, 'The root zarr.json'; 4.2 confirms)."
  type        = bool
  default     = true
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
  description = "WAF rate limit on /api/*: requests per IP per 5-minute window. Each is a Lambda invocation that may fan out to a few hundred S3 GETs on IC-WBT's bill; a hydrologist extending a network makes a handful. AWS minimum 100."
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
  description = "Monthly cost budget in USD; email + SNS at forecasted 100 %, actual 80 % and actual 100 % (80 %, not 50 %: the fixed baseline is about $11.80, about $13.60 with VAT, so a 50 % line on $25 would fire every month and teach the operator to ignore it). Credits and refunds are excluded, so new-account credits can't hide a runaway. Must be above 0; 0 is accepted only with no_budget_acknowledged = true (until IAM access to billing information is enabled on the account, docs/deployment.md § First deploy)."
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
  description = "Alarm when the API Lambda is invoked more than this many times in an hour: the early sign of a flood the WAF lets through (spread over many IPs)."
  type        = number
  default     = 2000
}

variable "cloudfront_requests_alarm_per_hour" {
  description = "Alarm when CloudFront serves more than this many requests in an hour (AWS/CloudFront Requests, us-east-1). The edge is the one spend path no cap bounds: a flood spread over many IPs stays under the per-IP WAF rules and is served from cache without touching the Lambda, at about $1.80 per million requests (WAF + CloudFront). An invite-only tool's handful of users make a few thousand an hour; 50 000 is about $0.09 an hour, so the alarm fires long before the money matters."
  type        = number
  default     = 50000
  validation {
    condition     = var.cloudfront_requests_alarm_per_hour > 0
    error_message = "cloudfront_requests_alarm_per_hour must be above 0."
  }
}

variable "cloudfront_gb_alarm_per_hour" {
  description = "Alarm when CloudFront sends more than this many GB to viewers in an hour (AWS/CloudFront BytesDownloaded, us-east-1). The whole site is a few MB per cold visit; 5 GB is about $0.55 an hour of South African egress. Revisit it when /tiles/* lands (docs/data.md row 6)."
  type        = number
  default     = 5
  validation {
    condition     = var.cloudfront_gb_alarm_per_hour > 0
    error_message = "cloudfront_gb_alarm_per_hour must be above 0."
  }
}
