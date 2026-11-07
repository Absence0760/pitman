# ----------------------------------------------------------------------------
# Budget, SNS topics and CloudWatch alarms
#
# The estate bootstrap deliberately creates no budget (a new member account
# can't create one until "IAM access to billing information" is enabled in
# it, a root-only toggle); each project owns its budget here. Until that
# toggle is on, set budget_monthly_usd = 0 or the apply fails with
# AccessDeniedException.
#
# Two topics, because a CloudWatch alarm can only notify an SNS topic in its
# own region: `alerts` (primary region: Lambda alarms, the budget) and
# `alerts_us_east_1` (CloudFront and WAF metrics exist only in us-east-1).
# alert_email subscribes to both.
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
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_sns_topic_subscription" "alerts_us_east_1_email" {
  count     = var.alert_email != "" ? 1 : 0
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.alerts_us_east_1.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# Budgets and CloudWatch may publish, and only on behalf of this account.
# The budget also emails alert_email directly, so it still reaches the
# operator if the topic subscription was never confirmed.
data "aws_iam_policy_document" "alerts_publish" {
  for_each = {
    primary   = aws_sns_topic.alerts.arn
    us_east_1 = aws_sns_topic.alerts_us_east_1.arn
  }

  statement {
    sid       = "AllowBudgetsAndCloudWatch"
    actions   = ["sns:Publish"]
    resources = [each.value]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com", "cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
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

# --- Monthly budget --------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  count        = var.budget_monthly_usd > 0 ? 1 : 0
  name         = "${local.project}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_monthly_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Forecasted is the only notification that catches a runaway during the
  # month; actual lags by up to a day.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.alert_email != "" ? [var.alert_email] : []
    subscriber_sns_topic_arns  = [aws_sns_topic.alerts.arn]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.alert_email != "" ? [var.alert_email] : []
    subscriber_sns_topic_arns  = [aws_sns_topic.alerts.arn]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.alert_email != "" ? [var.alert_email] : []
    subscriber_sns_topic_arns  = [aws_sns_topic.alerts.arn]
  }
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
  period              = 3600
  statistic           = "Sum"
  threshold           = var.lambda_invocations_alarm_per_hour
  alarm_description   = "API Lambda invoked more than lambda_invocations_alarm_per_hour times in an hour: a flood spread over IPs the WAF's per-IP rule doesn't catch."
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

  dimensions = {
    WebACL = aws_wafv2_web_acl.frontend.name
    Rule   = "ALL"
  }
}

# The auth WAF rule's blocks (us-east-1: CLOUDFRONT-scope WAF metrics live
# there). Any block means one IP passed auth_waf_rate_limit_per_ip sign-in
# calls in 5 minutes, far past a person signing in.
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
  alarm_description   = "The WAF's /api/auth/ rule blocked requests: one IP made more than auth_waf_rate_limit_per_ip sign-in calls in 5 minutes (code guessing or lockout spraying). See the rule's sampled requests in the WAF console."
  alarm_actions       = [aws_sns_topic.alerts_us_east_1.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    WebACL = aws_wafv2_web_acl.frontend.name
    Rule   = local.waf_auth_rule_metric
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
  alarm_description   = "SES bounce rate above 2.5 % (AWS reviews the account at 5 % and may pause sending, which stops sign-in). Check the Users page for flagged addresses; remove a listed address that no longer exists."
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
  alarm_description   = "SES complaint rate above 0.05 % (AWS reviews the account at 0.1 %). Someone marked a sign-in code as spam: check the Users page."
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
# function logs in Lambda's default Text format, which prefixes every line
# with a timestamp, request id and level, so the log event is not a JSON
# document and a JSON selector never matches it. The term matches the event
# name wherever it sits in the line, in either log format and whether the
# backend logs an object or a JSON string. Nothing else logs `auth.locked`.
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

# A dead-lettered bounce or complaint: the Lambda failed 5 times to record it,
# so the address isn't flagged on the Users page (SES has still suppressed it).
resource "aws_cloudwatch_metric_alarm" "mail_events_dlq" {
  alarm_name          = "${local.project}-mail-events-dlq"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "An SES bounce or complaint is in the mail-events DLQ: the Lambda failed 5 times to record it. Read the Lambda's errors, fix, then redrive the DLQ (SQS console, Start DLQ redrive)."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.mail_events_dlq.name
  }
}
