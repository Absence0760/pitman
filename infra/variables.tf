variable "aws_region" {
  description = "Primary AWS region for Lambda and S3 resources."
  type        = string
  default     = "us-east-1"
}

variable "domain_name" {
  description = "Apex domain for the site, e.g. example.com"
  type        = string
}

variable "route53_zone_id" {
  description = <<-EOT
    ID of the Route 53 hosted zone for the apex domain. The zone must already
    exist — Terraform will add records to it but will not create it. Look it up
    with: aws route53 list-hosted-zones-by-name --dns-name <domain>
  EOT
  type        = string
}

variable "github_repo" {
  description = "GitHub repository in 'owner/name' form. Surfaced via tags; reserved for future use."
  type        = string
}

variable "bootstrap_slug" {
  description = <<-EOT
    Project slug used by the cross-project bootstrap when creating the OIDC
    deploy role. The lookup in oidc.tf reads `data "aws_iam_role" "github_deploy"
    { name = "$${var.bootstrap_slug}-deploy" }`, so this MUST match the slug
    the bootstrap was run with (the `project` field in
    infra/bootstrap/projects/<slug>.tfvars on ~/repos/templates). Mismatch
    surfaces as a plan-time "role not found" error.
  EOT
  type        = string
  default     = "pitman"
}

variable "site_url" {
  description = "Public URL of the site. Defaults to https://<domain_name>."
  type        = string
  default     = ""
}

variable "waf_rate_limit_per_ip" {
  description = "WAF rate-limit threshold: requests per IP per 5-minute rolling window. AWS minimum is 100."
  type        = number
  default     = 1000
  validation {
    condition     = var.waf_rate_limit_per_ip >= 100
    error_message = "AWS WAF rate-based rule minimum is 100 per 5-minute window."
  }
}

variable "budget_monthly_usd" {
  description = "Monthly AWS spend ceiling in USD. Forecasted + actual notifications fire SNS at 50% / 100% / forecasted 100%. Set to 0 to skip budget creation entirely (NOT recommended for prod)."
  type        = number
  default     = 25
}

variable "budget_alert_email" {
  description = "Email address that receives SNS budget + alarm notifications. Leave empty to skip the SNS subscription (alarms still fire visibly in the console but nobody is paged)."
  type        = string
  default     = ""
}

variable "lambda_log_retention_days" {
  description = "CloudWatch log retention for the backend Lambda. Default 30 days; bump for compliance / audit horizons."
  type        = number
  default     = 30
}

variable "lambda_reserved_concurrency" {
  description = "Max concurrent Lambda executions. Bounds worst-case spend during an attack. Requires the account's UnreservedConcurrentExecutions quota >= 10 (Service Quotas → Lambda → Concurrent executions). Set to -1 to use the account's unreserved pool."
  type        = number
  default     = 20
}
