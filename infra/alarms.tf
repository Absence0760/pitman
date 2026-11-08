# ----------------------------------------------------------------------------
# Budget, SNS topics and CloudWatch alarms
#
# The estate bootstrap deliberately creates no budget (a new member account
# can't create one until "IAM access to billing information" is enabled in
# it, a root-only toggle); each project owns its budget here. Until that
# toggle is on, set budget_monthly_usd = 0 together with the explicit opt-out
# no_budget_acknowledged = true (variables.tf refuses 0 without it), or the
# apply fails with AccessDeniedException.
#
# Two topics, because a CloudWatch alarm can only notify an SNS topic in its
# own region: `alerts` (primary region: Lambda alarms, the breaker) and
# `alerts_us_east_1` (CloudFront, WAF and Route 53 metrics exist only in
# us-east-1; also the budgets and Cost Anomaly Detection, below).
# alert_email (required, and refused on a reserved example domain) subscribes
# to both.
# ----------------------------------------------------------------------------

# Not SSE-encrypted: CloudWatch alarms can't publish to a topic under the
# AWS-managed alias/aws/sns key (its key policy can't be extended), and a
# customer key costs $1/month for alert text that holds nothing sensitive.
#trivy:ignore:AVD-AWS-0095 alarm and budget notifications only; see above
resource "aws_sns_topic" "alerts" {
  name = "${local.project}-prod-alerts"
}

#trivy:ignore:AVD-AWS-0095 alarm notifications only; see above
resource "aws_sns_topic" "alerts_us_east_1" {
  provider = aws.us_east_1
  name     = "${local.project}-prod-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_sns_topic_subscription" "alerts_us_east_1_email" {
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.alerts_us_east_1.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# CloudWatch may publish to each topic, only on behalf of this account.
# Budgets publishes only to the us-east-1 topic: Budgets is a global service
# billed from us-east-1, and its SNS guide
# (docs.aws.amazon.com/cost-management/latest/userguide/budgets-sns-policy.html)
# requires a same-account topic but says nothing of opt-in regions, so the
# budget doesn't depend on af-south-1. Its statement is AWS's recommended
# one: aws:SourceAccount plus aws:SourceArn on this account's budgets. The
# budgets also email alert_email directly, so they still reach the operator
# if the topic subscription was never confirmed (the anomaly subscription
# can't: it reaches the operator only through the topic).
data "aws_iam_policy_document" "alerts_publish" {
  for_each = {
    primary   = aws_sns_topic.alerts.arn
    us_east_1 = aws_sns_topic.alerts_us_east_1.arn
  }

  statement {
    sid       = "AllowCloudWatch"
    actions   = ["sns:Publish"]
    resources = [each.value]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }

  dynamic "statement" {
    for_each = each.key == "us_east_1" ? [each.value] : []
    content {
      sid       = "AllowBudgets"
      actions   = ["sns:Publish"]
      resources = [statement.value]
      principals {
        type        = "Service"
        identifiers = ["budgets.amazonaws.com"]
      }
      condition {
        test     = "StringEquals"
        variable = "aws:SourceAccount"
        values   = [local.account_id]
      }
      condition {
        test     = "ArnLike"
        variable = "aws:SourceArn"
        values   = ["arn:aws:budgets::${local.account_id}:*"]
      }
    }
  }

  # Cost Anomaly Detection's subscription (below) publishes as
  # costalerts.amazonaws.com, also to the us-east-1 topic only (Cost Explorer
  # is served from there). The statement is ewr-compliance's: this account
  # only.
  dynamic "statement" {
    for_each = each.key == "us_east_1" ? [each.value] : []
    content {
      sid       = "AllowCostAnomalyDetection"
      actions   = ["sns:Publish"]
      resources = [statement.value]
      principals {
        type        = "Service"
        identifiers = ["costalerts.amazonaws.com"]
      }
      condition {
        test     = "StringEquals"
        variable = "aws:SourceAccount"
        values   = [local.account_id]
      }
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_publish["primary"].json
}

resource "aws_sns_topic_policy" "alerts_us_east_1" {
  provider = aws.us_east_1
  arn      = aws_sns_topic.alerts_us_east_1.arn
  policy   = data.aws_iam_policy_document.alerts_publish["us_east_1"].json
}

# --- Budgets -----------------------------------------------------------------
# Two (AWS gives two free an account), both emailing alert_email directly and
# notifying the us-east-1 topic (after ewr-compliance's alarms.tf):
#   - Monthly: FORECASTED 100 %, ACTUAL 80 % and ACTUAL 100 %.
#   - Daily: ACTUAL 100 % only (a daily budget has no forecast). The first
#     month's guard, before the monthly forecast has any history: a runaway
#     is mailed about a day after it starts, not when the month's total
#     passes 80 %. Derived as ceil(monthly x 2.25 / 30) unless
#     budget_daily_usd is set: $2 a day on $25, well above the ~$0.43 a day
#     of fixed cost, so an ordinary day never fires it.
# Billing data lags by up to a day, so both report what a runaway has already
# cost: they are the backstop behind the breaker (breaker.tf) and the
# 5-minute alarms below, which say it is happening.

locals {
  budget_daily_usd = (
    var.budget_daily_usd != null
    ? var.budget_daily_usd
    : ceil(var.budget_monthly_usd * 2.25 / 30)
  )
}

resource "aws_budgets_budget" "monthly" {
  count        = var.budget_monthly_usd > 0 ? 1 : 0
  name         = "${local.project}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_monthly_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Gross cost: AWS's default nets credits and refunds out, so new-account
  # or promotional credits would hide a runaway until they ran out.
  cost_types {
    include_credit = false
    include_refund = false
  }

  # Forecasted is the only notification that catches a runaway during the
  # month (though AWS needs some spend history before it forecasts, so it is
  # quiet in the first weeks); actual lags by up to a day. The early actual
  # line is 80 %, not 50 %: the fixed baseline is about $12.80 a month
  # ($14.70 with VAT, infra/README.md § Cost), so 50 % of $25 would fire
  # every month. The CloudWatch alarms are the fast layer; this is the
  # backstop.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
    subscriber_sns_topic_arns  = [aws_sns_topic.alerts_us_east_1.arn]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
    subscriber_sns_topic_arns  = [aws_sns_topic.alerts_us_east_1.arn]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
    subscriber_sns_topic_arns  = [aws_sns_topic.alerts_us_east_1.arn]
  }

  # The topic policy must admit Budgets before the budget validates its SNS
  # subscriber, or the create fails with "Invalid SNS topic".
  depends_on = [aws_sns_topic_policy.alerts_us_east_1]
}

resource "aws_budgets_budget" "daily" {
  count        = var.budget_monthly_usd > 0 && local.budget_daily_usd > 0 ? 1 : 0
  name         = "${local.project}-daily"
  budget_type  = "COST"
  limit_amount = tostring(local.budget_daily_usd)
  limit_unit   = "USD"
  time_unit    = "DAILY"

  # Gross, like the monthly one.
  cost_types {
    include_credit = false
    include_refund = false
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
    subscriber_sns_topic_arns  = [aws_sns_topic.alerts_us_east_1.arn]
  }

  depends_on = [aws_sns_topic_policy.alerts_us_east_1]
}

# --- Cost Anomaly Detection (free) -------------------------------------------
# Off by default (cost_anomaly_threshold_usd = 0): an account may hold only
# one dimensional (SERVICE) monitor, and AWS may already have made one (the
# console offers it when Cost Explorer is first opened), which would fail the
# first apply. Turn it on after the first apply (docs/deployment.md § First
# deploy). It learns from the account's own history, so it is quiet for the
# first weeks, and it reads the same lagging billing data as the budgets: a
# backstop, not the fast layer. Cost Explorer is served from us-east-1.

resource "aws_ce_anomaly_monitor" "services" {
  count             = var.cost_anomaly_threshold_usd > 0 ? 1 : 0
  provider          = aws.us_east_1
  name              = "${local.project}-services"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "services" {
  count            = var.cost_anomaly_threshold_usd > 0 ? 1 : 0
  provider         = aws.us_east_1
  name             = "${local.project}-anomalies"
  frequency        = "IMMEDIATE"
  monitor_arn_list = [aws_ce_anomaly_monitor.services[0].arn]

  # IMMEDIATE allows only an SNS subscriber; alert_email gets it through the
  # topic's email subscription.
  subscriber {
    type    = "SNS"
    address = aws_sns_topic.alerts_us_east_1.arn
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.cost_anomaly_threshold_usd)]
    }
  }

  depends_on = [aws_sns_topic_policy.alerts_us_east_1]
}

# --- Lambda alarms (primary region) ----------------------------------------

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "${local.project}-lambda-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "API Lambda: more than 5 errors in 5 minutes."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.backend.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  alarm_name          = "${local.project}-lambda-throttles"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Throttles"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "API Lambda hit its reserved concurrency (lambda_reserved_concurrency): a flood, or real use outgrowing the cap."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.backend.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_invocations" {
  alarm_name          = "${local.project}-lambda-invocations"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Invocations"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = ceil(var.lambda_invocations_alarm_per_hour / 12)
  alarm_description   = "API Lambda invoked faster than lambda_invocations_alarm_per_hour an hour, over 5 minutes: a flood spread over IPs the WAF's per-IP rule doesn't catch. The breaker (breaker.tf) stops sustained compute; this is the mail."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.backend.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_duration" {
  alarm_name          = "${local.project}-lambda-duration"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 300
  extended_statistic  = "p95"
  threshold           = var.lambda_timeout_seconds * 1000 * 0.8
  alarm_description   = "API Lambda p95 duration above 80 % of its timeout: requests are about to time out (and every second is billed)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.backend.function_name
  }
}

# --- CloudFront and WAF alarms (us-east-1) ---------------------------------

resource "aws_cloudwatch_metric_alarm" "cloudfront_5xx" {
  provider            = aws.us_east_1
  alarm_name          = "${local.project}-cloudfront-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "5xxErrorRate"
  namespace           = "AWS/CloudFront"
  period              = 300
  statistic           = "Average"
  threshold           = 1
  alarm_description   = "CloudFront 5xx rate above 1 % over 5 minutes."
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    DistributionId = aws_cloudfront_distribution.frontend.id
    Region         = "Global"
  }
}

# Traffic at the edge (us-east-1, free default CloudFront metrics). The one
# spend path nothing caps: a flood spread over many IPs stays under every
# per-IP WAF rule, is served from the edge cache and never reaches the
# Lambda, so none of the Lambda alarms or the breaker see it, and the budget
# lags by a day. Each request costs $2.00 per million (CloudFront $1.20 at
# South African and Indian edges, WAF $0.60, two Functions $0.20) plus $0.110 a
# GB, so these 5-minute sums are the early warning: mail within about 5-10
# minutes, not the 1-2 hours of an hourly sum. The variables stay per hour;
# each threshold is a twelfth of one. Thresholds and what passes under them:
# variables.tf. The durable fix, CloudFront's flat-rate Pro plan, is the
# operator's decision (infra/README.md § Cost).
resource "aws_cloudwatch_metric_alarm" "cloudfront_requests" {
  provider            = aws.us_east_1
  alarm_name          = "${local.project}-cloudfront-requests"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Requests"
  namespace           = "AWS/CloudFront"
  period              = 300
  statistic           = "Sum"
  threshold           = ceil(var.cloudfront_requests_alarm_per_hour / 12)
  alarm_description   = "CloudFront served requests faster than cloudfront_requests_alarm_per_hour an hour, over 5 minutes: far above an invite-only tool's traffic, likely a flood spread over many IPs (each request is billed; nothing caps it). Kill switch: docs/security.md § Incident playbook."
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    DistributionId = aws_cloudfront_distribution.frontend.id
    Region         = "Global"
  }
}

resource "aws_cloudwatch_metric_alarm" "cloudfront_bytes" {
  provider            = aws.us_east_1
  alarm_name          = "${local.project}-cloudfront-bytes"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "BytesDownloaded"
  namespace           = "AWS/CloudFront"
  period              = 300
  statistic           = "Sum"
  threshold           = ceil(var.cloudfront_gb_alarm_per_hour * 1024 * 1024 * 1024 / 12)
  alarm_description   = "CloudFront sent GB to viewers faster than cloudfront_gb_alarm_per_hour an hour, over 5 minutes: egress far above an invite-only tool's traffic (billed per GB; nothing caps it). Kill switch: docs/security.md § Incident playbook."
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    DistributionId = aws_cloudfront_distribution.frontend.id
    Region         = "Global"
  }
}

# DNS queries on the site's zone (us-east-1: Route 53's public DNS query
# metrics are published only there). Queries for the CloudFront alias
# records are free, but a random-subdomain flood (NXDOMAIN answers) and the
# SES records are billed at $0.40 per million, and nothing caps them. The
# zone is the bootstrap's, looked up in s3_cloudfront.tf.
resource "aws_cloudwatch_metric_alarm" "route53_queries" {
  provider            = aws.us_east_1
  alarm_name          = "${local.project}-route53-queries"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "DNSQueries"
  namespace           = "AWS/Route53"
  period              = 300
  statistic           = "Sum"
  threshold           = ceil(var.route53_queries_alarm_per_hour / 12)
  alarm_description   = "The site's hosted zone answered DNS queries faster than route53_queries_alarm_per_hour an hour, over 5 minutes: far above an invite-only tool's traffic (resolvers cache the records), likely a random-subdomain flood. Billed per query; nothing caps it."
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    HostedZoneId = data.aws_route53_zone.site.zone_id
  }
}

resource "aws_cloudwatch_metric_alarm" "waf_blocked" {
  provider            = aws.us_east_1
  alarm_name          = "${local.project}-waf-blocked"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "BlockedRequests"
  namespace           = "AWS/WAFV2"
  period              = 300
  statistic           = "Sum"
  threshold           = 100
  alarm_description   = "WAF blocked more than 100 requests in 5 minutes: someone is past a rate limit (or a real user is, and the limit needs raising)."
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  treat_missing_data  = "notBreaching"

  # WAF's WebACL dimension is the ACL's metric name, not its resource name.
  dimensions = {
    WebACL = aws_wafv2_web_acl.frontend.visibility_config[0].metric_name
    Rule   = "ALL"
  }
}

# The auth WAF rule's blocks (us-east-1: CLOUDFRONT-scope WAF metrics live
# there). Any block means one IP made more than auth_waf_rate_limit_per_ip
# sign-in calls (code, verify, logout; /api/auth/me is exempt, waf.tf) in 5
# minutes, far more than a person signing in makes.
resource "aws_cloudwatch_metric_alarm" "waf_auth_blocked" {
  provider            = aws.us_east_1
  alarm_name          = "${local.project}-waf-auth-blocked"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "BlockedRequests"
  namespace           = "AWS/WAFV2"
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "The WAF's /api/auth/ rule blocked requests: one IP made more than auth_waf_rate_limit_per_ip sign-in calls in 5 minutes (code guessing or lockout spraying; /api/auth/me is not counted). Sampled requests are off (waf.tf), so look for auth.locked alarms and the audit rows on the Users page."
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  treat_missing_data  = "notBreaching"

  # Both dimensions are metric names from the ACL's visibility configs.
  dimensions = {
    WebACL = aws_wafv2_web_acl.frontend.visibility_config[0].metric_name
    Rule   = one([for r in aws_wafv2_web_acl.frontend.rule : r.visibility_config[0].metric_name if r.name == "RateLimitAuthPerIP"])
  }
}

# --- Users and sign-in (issue #28, primary region) ---------------------------

# SES account-level reputation (AWS/SES, no dimensions). AWS reviews an
# account at a 5 % bounce or 0.1 % complaint rate and can pause sending, which
# would stop every sign-in; these fire at half. Nothing to page on while
# nothing is sent, hence notBreaching.
resource "aws_cloudwatch_metric_alarm" "ses_bounce_rate" {
  alarm_name          = "${local.project}-ses-bounce-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Reputation.BounceRate"
  namespace           = "AWS/SES"
  period              = 3600
  statistic           = "Maximum"
  threshold           = 0.025
  alarm_description   = "SES bounce rate above 2.5 % (AWS reviews the account at 5 % and may pause sending, which stops sign-in). Bounces are logged as mail.bounce in the API Lambda's log group (no address; flagging on the Users page comes with auth-kit v0.2.0); `aws sesv2 list-suppressed-destinations` names the addresses. Remove a listed user whose address no longer exists."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "ses_complaint_rate" {
  alarm_name          = "${local.project}-ses-complaint-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Reputation.ComplaintRate"
  namespace           = "AWS/SES"
  period              = 3600
  statistic           = "Maximum"
  threshold           = 0.0005
  alarm_description   = "SES complaint rate above 0.05 % (AWS reviews the account at 0.1 %). Someone marked a sign-in code as spam: `aws sesv2 list-suppressed-destinations --reasons COMPLAINT` names the address (it is logged as mail.complaint, without the address)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# Throttles and system errors on the user table. DynamoDB publishes
# ThrottledRequests and SystemErrors per TableName + Operation only, so each
# alarm sums the operations the Lambda makes (TransactWriteItems carries the
# Put/Update/Delete/ConditionCheck items of every change). Every gated request
# reads the table, so any throttle or 5xx is worth a look.
locals {
  users_table_operations = {
    getitem  = "GetItem"
    query    = "Query"
    putitem  = "PutItem"
    update   = "UpdateItem"
    deletion = "DeleteItem"
    transact = "TransactWriteItems"
  }

  users_table_alarms = {
    throttles = {
      metric      = "ThrottledRequests"
      description = "The user table throttled requests in the last 5 minutes: sign-in and every gated request read it."
    }
    system-errors = {
      metric      = "SystemErrors"
      description = "DynamoDB returned 5xx on the user table (an AWS-side fault): sign-in or the gate may be failing closed (503). Check the AWS Health dashboard for the region."
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "users_table" {
  for_each = local.users_table_alarms

  alarm_name          = "${local.project}-users-table-${each.key}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  alarm_description   = each.value.description
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "total"
    expression  = join(" + ", [for k in sort(keys(local.users_table_operations)) : "FILL(${k}, 0)"])
    label       = "${each.value.metric}, all operations"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = local.users_table_operations
    content {
      id = metric_query.key
      metric {
        metric_name = each.value.metric
        namespace   = "AWS/DynamoDB"
        period      = 300
        stat        = "Sum"
        dimensions = {
          TableName = aws_dynamodb_table.users.name
          Operation = metric_query.value
        }
      }
    }
  }
}

# auth.locked: auth-kit locked an address after repeated wrong codes. Anyone
# can do that to an admin by failing codes against their address (the known
# risk in docs/security.md), so every one is surfaced. The line carries an
# opaque id and the event name only (A-AUTH-11).
#
# The pattern is a quoted term, not a JSON selector ({ $.event = ... }): the
# function logs in Lambda's JSON format (lambda.tf), which wraps each line
# the backend writes in a record whose `message` field holds it, so the event
# name sits inside a string, not at `$.event`, and a JSON selector on it
# never matches. The term matches the event name wherever it sits, in either
# log format and whether the backend logs an object or a JSON string.
# Nothing else logs `auth.locked`.
resource "aws_cloudwatch_log_metric_filter" "auth_locked" {
  name           = "${local.project}-auth-locked"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "\"auth.locked\""

  metric_transformation {
    name          = "AuthLocked"
    namespace     = "${local.project}/Auth"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "auth_locked" {
  alarm_name          = "${local.project}-auth-locked"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.auth_locked.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.auth_locked.metric_transformation[0].namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "An address was locked out of sign-in after repeated wrong codes. If it's an admin who didn't do it, someone is guessing or locking them out: check the audit rows on the Users page; `pnpm admin:recover` is the break-glass."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# mail.send_failed: SES refused a sign-in code. Since #30 the mail-queue worker
# sends it (backend/src/auth/mailWorker.ts), after /auth/code has answered
# 202; the error is caught and the record retried (up to 3 receives, then the
# mail-send DLQ), so neither the Lambda error alarm nor the SES reputation
# alarms see it. Each try logs a line. One may mean every sign-in is failing silently: the account is in the
# SES sandbox or paused, DKIM fell back to pending, the configuration set is
# disabled, or the IAM grant's ses:FromAddress no longer matches MAIL_FROM.
# Same quoted-term pattern as auth.locked; the line carries the user's id and
# the SES error name only (mailQueue.ts).
resource "aws_cloudwatch_log_metric_filter" "mail_send_failed" {
  name           = "${local.project}-mail-send-failed"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "\"mail.send_failed\""

  metric_transformation {
    name          = "MailSendFailed"
    namespace     = "${local.project}/Auth"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "mail_send_failed" {
  alarm_name          = "${local.project}-mail-send-failed"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.mail_send_failed.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.mail_send_failed.metric_transformation[0].namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "SES refused to send a sign-in code (the mail-queue worker tries it up to 3 times): the user sees 'check your email' and may get nothing. The log line's error names the cause, e.g. MessageRejected (SES sandbox or an unverified identity), AccessDenied (the IAM grant or MAIL_FROM), AccountSuspended or SendingPausedException (reputation). Check `aws sesv2 get-account` and the identity's DKIM status."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# auth.unconfigured: the Lambda's sign-in configuration is unusable (a key
# missing or short, the keys equal, no table, a transport other than SES), so
# every gated route answers 503 (runtime.ts logs it). Without this only the
# CloudFront 5xx alarm notices, at 1 % of all requests, static hits included.
resource "aws_cloudwatch_log_metric_filter" "auth_unconfigured" {
  name           = "${local.project}-auth-unconfigured"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "\"auth.unconfigured\""

  metric_transformation {
    name          = "AuthUnconfigured"
    namespace     = "${local.project}/Auth"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "auth_unconfigured" {
  alarm_name          = "${local.project}-auth-unconfigured"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.auth_unconfigured.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.auth_unconfigured.metric_transformation[0].namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "Sign-in is unconfigured on the API Lambda, so every gated route answers 503. The log line's problem field names what is wrong (backend/src/auth/config.ts); check the function's environment against docs/deployment.md § Lambda environment."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# auth.send_capped: a listed address reached its daily cap of sign-in code
# sends. A person asks for a code two or three times; reaching the cap means
# someone is requesting codes for that address over and over (mail bombing a
# user, or burning SES reputation). Same quoted-term pattern as auth.locked;
# the line carries the event name only. A 15-minute window: the cap is daily,
# so one per window is plenty of signal without re-alarming on every request.
resource "aws_cloudwatch_log_metric_filter" "auth_send_capped" {
  name           = "${local.project}-auth-send-capped"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "\"auth.send_capped\""

  metric_transformation {
    name          = "AuthSendCapped"
    namespace     = "${local.project}/Auth"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "auth_send_capped" {
  alarm_name          = "${local.project}-auth-send-capped"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.auth_send_capped.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.auth_send_capped.metric_transformation[0].namespace
  period              = 900
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "A listed address reached its daily cap of sign-in code sends: someone is requesting codes for it repeatedly (mail bombing, or a user stuck in a loop). The user can sign in again tomorrow; check the audit rows on the Users page and the WAF block alarms."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# A dead-lettered bounce or complaint: the Lambda didn't take it in 5 receives
# (SES has still suppressed the address). The handler only logs today and
# never reports a record as failed, so this means a crash, a timeout or a
# throttle (a flood holding every reserved copy busy, ses.tf), not bad input.
resource "aws_cloudwatch_metric_alarm" "mail_events_dlq" {
  alarm_name          = "${local.project}-mail-events-dlq"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "An SES bounce or complaint is in the mail-events DLQ: the Lambda didn't take it in 5 receives (a crash, timeout or throttle). Read the Lambda's errors and throttles, fix, then redrive the DLQ (SQS console, Start DLQ redrive)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.mail_events_dlq.name
  }
}

# auth.slow_code_request: a /auth/code request ran past its 1 s minimum-latency
# floor (backend/src/auth/routes.ts): the user table or the SQS enqueue was
# slow. Since #30 no mail is sent inside the request and a listed and an
# unlisted address do the same work, so a slow request is slow for both; what
# a run of these can still leak is the difference in auth-kit's own store work
# past the floor. A single slow request is noise; three in 15 minutes is not.
resource "aws_cloudwatch_log_metric_filter" "auth_slow_code_request" {
  name           = "${local.project}-auth-slow-code-request"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "\"auth.slow_code_request\""

  metric_transformation {
    name          = "AuthSlowCodeRequest"
    namespace     = "${local.project}/Auth"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "auth_slow_code_request" {
  alarm_name          = "${local.project}-auth-slow-code-request"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.auth_slow_code_request.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.auth_slow_code_request.metric_transformation[0].namespace
  period              = 900
  statistic           = "Sum"
  threshold           = 3
  alarm_description   = "Sign-in code requests are running past their 1 s minimum-latency floor: the user table or the SQS enqueue is slow (no mail is sent inside the request). Check the user-table alarms, the mail-enqueue-failed alarm and SQS in af-south-1."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# cloudfront_secret.unset: the Lambda has no CloudFront shared secret, so it
# answers 503 to everything (backend/src/app.ts fails closed). Terraform always
# sets it, so this means the function's environment was changed by hand.
resource "aws_cloudwatch_log_metric_filter" "cloudfront_secret_unset" {
  name           = "${local.project}-cloudfront-secret-unset"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "\"cloudfront_secret.unset\""

  metric_transformation {
    name          = "CloudFrontSecretUnset"
    namespace     = "${local.project}/Auth"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "cloudfront_secret_unset" {
  alarm_name          = "${local.project}-cloudfront-secret-unset"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.cloudfront_secret_unset.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.cloudfront_secret_unset.metric_transformation[0].namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "The API Lambda has no CLOUDFRONT_SHARED_SECRET and answers 503 to every request. Re-apply infra/ (terraform apply) to restore its environment."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# mail.record_failed: see backend/src/auth/mailEvents.ts.
resource "aws_cloudwatch_log_metric_filter" "mail_record_failed" {
  name           = "${local.project}-mail-record-failed"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "\"mail.record_failed\""

  metric_transformation {
    name          = "MailRecordFailed"
    namespace     = "${local.project}/Auth"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "mail_record_failed" {
  alarm_name          = "${local.project}-mail-record-failed"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.mail_record_failed.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.mail_record_failed.metric_transformation[0].namespace
  period              = 900
  statistic           = "Sum"
  threshold           = 3
  alarm_description   = "Bounce or complaint flags are failing to save in the users table (store errors; SQS redelivers them). Check the user-table alarms and the Lambda's errors; persistent failures end in the mail-events DLQ."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# mail.events_unrecorded (backend/src/auth/mailEvents.ts) and
# mail.queue_unsent (backend/src/auth/mailWorker.ts): bounce events or queued
# sign-in mail arriving while sign-in is unconfigured, redelivered each time.
resource "aws_cloudwatch_log_metric_filter" "mail_events_unrecorded" {
  name           = "${local.project}-mail-events-unrecorded"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "?\"mail.events_unrecorded\" ?\"mail.queue_unsent\""

  metric_transformation {
    name          = "MailEventsUnrecorded"
    namespace     = "${local.project}/Auth"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "mail_events_unrecorded" {
  alarm_name          = "${local.project}-mail-events-unrecorded"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.mail_events_unrecorded.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.mail_events_unrecorded.metric_transformation[0].namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "SES bounce and complaint events (mail.events_unrecorded) or queued sign-in mail (mail.queue_unsent) are arriving while sign-in is unconfigured, so they can't be recorded or sent and are being redelivered. Fix the auth-unconfigured alarm first; queued codes expire after 10 minutes."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# mail.event_refused (auth-kit refused a recipient's address or time) and
# mail.event_ignored (a record that can't be read, or of a kind other than
# Bounce or Complaint): see backend/src/auth/mailEvents.ts. Both are dropped
# without a retry, so the bounce or complaint is never recorded; the only
# other trace is a count inside a mail.bounce / mail.complaint line. One
# filter, either term (CloudWatch Logs' `?term ?term` OR syntax, each term
# quoted because it holds a dot).
resource "aws_cloudwatch_log_metric_filter" "mail_events_dropped" {
  name           = "${local.project}-mail-events-dropped"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "?\"mail.event_refused\" ?\"mail.event_ignored\""

  metric_transformation {
    name          = "MailEventsDropped"
    namespace     = "${local.project}/Auth"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "mail_events_dropped" {
  alarm_name          = "${local.project}-mail-events-dropped"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.mail_events_dropped.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.mail_events_dropped.metric_transformation[0].namespace
  period              = 3600
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "An SES bounce or complaint event was dropped unrecorded (mail.event_refused: auth-kit refused a recipient's address or timestamp; mail.event_ignored: unreadable or an unexpected event type). SES's event shape or timestamps may have changed, so bounces and complaints aren't being recorded on the Users page. Read the Lambda's mail.* log lines and compare with SES's current event format."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# --- The sign-in mail queue (mail_queue.tf, issue #30) ------------------------

# mail.enqueue_failed: /auth/code couldn't put the email on the queue (SQS
# refused, or the grant or MAIL_QUEUE_URL is wrong). The request still answers
# 202, so nothing else sees it: the user waits for a code that never comes.
# Logged for a listed address and an unlisted one's decoy alike (routes.ts).
resource "aws_cloudwatch_log_metric_filter" "mail_enqueue_failed" {
  name           = "${local.project}-mail-enqueue-failed"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "\"mail.enqueue_failed\""

  metric_transformation {
    name          = "MailEnqueueFailed"
    namespace     = "${local.project}/Auth"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "mail_enqueue_failed" {
  alarm_name          = "${local.project}-mail-enqueue-failed"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.mail_enqueue_failed.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.mail_enqueue_failed.metric_transformation[0].namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "POST /auth/code couldn't enqueue a sign-in email (the request still answered 202, so the user waits for nothing). The log line's error names the cause, e.g. AccessDenied (the role's sqs:SendMessage grant) or QueueDoesNotExist (MAIL_QUEUE_URL). Check the pitman-mail-send queue and the Lambda's environment."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# mail.send_expired (a queued code had expired before it could be sent: a
# backlog, or retries that ran out its 10 minutes) and mail.queue_unreadable
# (a body that won't open: AUTH_CODE_KEY rotated with mail in flight, or
# something other than /auth/code wrote to the queue). Both are dropped, so a
# user got no code. One filter, as for mail_events_dropped.
resource "aws_cloudwatch_log_metric_filter" "mail_send_dropped" {
  name           = "${local.project}-mail-send-dropped"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "?\"mail.send_expired\" ?\"mail.queue_unreadable\""

  metric_transformation {
    name          = "MailSendDropped"
    namespace     = "${local.project}/Auth"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "mail_send_dropped" {
  alarm_name          = "${local.project}-mail-send-dropped"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = aws_cloudwatch_log_metric_filter.mail_send_dropped.metric_transformation[0].name
  namespace           = aws_cloudwatch_log_metric_filter.mail_send_dropped.metric_transformation[0].namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "A queued sign-in email was dropped unsent: mail.send_expired (its code expired first: a backlog or failing sends, see the mail-send-age and mail-send-failed alarms) or mail.queue_unreadable (a body that won't open: AUTH_CODE_KEY was rotated with mail in flight, or something else wrote to pitman-mail-send). The user asks for a new code."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"
}

# A dead-lettered sign-in email: SES refused it 3 times (each logged as
# mail.send_failed), or the function crashed, timed out or was throttled on
# it. The code inside has expired or soon will, so there is nothing to
# redrive: fix the cause and let the DLQ's 1-day retention clear it.
resource "aws_cloudwatch_metric_alarm" "mail_send_dlq" {
  alarm_name          = "${local.project}-mail-send-dlq"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "A sign-in email is in the mail-send DLQ: it failed 3 receives (SES refusals, logged as mail.send_failed, or a Lambda crash, timeout or throttle). Its code has expired, so don't redrive it: fix the cause (the mail-send-failed alarm, the Lambda's errors and throttles); the DLQ clears itself within a day."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.mail_send_dlq.name
  }
}

# The oldest sign-in email has waited more than 2 minutes: the mapping isn't
# consuming (disabled, throttled by a flood holding every reserved copy, or
# failing). Users are waiting on codes that expire at 10 minutes, when SQS
# deletes the message (its retention) without dead-lettering it, so this is
# the only alarm that sees a queue nobody reads.
resource "aws_cloudwatch_metric_alarm" "mail_send_age" {
  alarm_name          = "${local.project}-mail-send-age"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 120
  alarm_description   = "A sign-in email has waited over 2 minutes on pitman-mail-send: the Lambda isn't consuming the queue (event source mapping disabled, throttled or failing). Codes expire at 10 minutes. Check the mapping's state (aws lambda list-event-source-mappings), the Lambda's throttles and errors."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.mail_send.name
  }
}
