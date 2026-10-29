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
