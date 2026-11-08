# ----------------------------------------------------------------------------
# Spend circuit breaker (pre-first-deploy cost audit, 2026-11-07; decision
# R4-I7). The budget only mails, and a budget action can't throttle a Lambda
# (its targets are IAM policies, SCPs and EC2/RDS), so this stops the API by
# itself:
#
#   breaker alarms (below) ──► SNS pitman-breaker ──► Lambda pitman-breaker
#                         └──► alerts (mail)           PutFunctionConcurrency 0
#                                                      on pitman-backend
#
# Two trips, both on what is billed (GB-seconds), not on a proxy for it:
#   - ConcurrentExecutions (Maximum) >= breaker_concurrency_threshold (6) in
#     3 consecutive 5-minute periods: saturation, stopped within ~15 minutes.
#   - Duration (Sum) over a clock hour > breaker_duration_ms_per_hour
#     (7 200 000 ms = 2 copies busy the whole hour): a quieter or pulsed
#     load that never holds 6 copies for 15 minutes, stopped within 1-2 h.
# Below both, the API's compute averages under 2 copies: at most
# 2 x 1 GB x 2 592 000 s x $0.00001768 = $91.66 a month (infra/README.md §
# Cost).
#
# Reset: `terraform apply` puts reserved_concurrent_executions back to
# var.lambda_reserved_concurrency (aws_lambda_function.backend owns it, so the
# breaker's 0 is drift), or the one-line CLI reset in docs/security.md §
# Incident playbook. While tripped the API answers 429, sign-in mail waits on
# its queue and expires with its code, and the static site stays up.
#
# Cost: the topic and the function are free at this volume (they run only on
# a trip); three alarm metrics, $0.30 a month.
# ----------------------------------------------------------------------------

#trivy:ignore:AVD-AWS-0095 alarm notifications only, as the alert topics (alarms.tf)
resource "aws_sns_topic" "breaker" {
  name = "${local.project}-breaker"
}

# Only CloudWatch, on behalf of this account, may publish: nothing else can
# trip the breaker.
data "aws_iam_policy_document" "breaker_publish" {
  statement {
    sid       = "AllowCloudWatchAlarms"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.breaker.arn]
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
}

resource "aws_sns_topic_policy" "breaker" {
  arn    = aws_sns_topic.breaker.arn
  policy = data.aws_iam_policy_document.breaker_publish.json
}

# --- The function --------------------------------------------------------------

data "aws_iam_policy_document" "breaker_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "breaker" {
  name               = "${local.project}-breaker"
  assume_role_policy = data.aws_iam_policy_document.breaker_assume_role.json
}

# Exactly one permission on the API: set its reserved concurrency. Plus its
# own log group. No sns:Publish (the alarms mail the operator), no
# DeleteFunctionConcurrency (that would make the API unreserved, uncapped).
resource "aws_iam_role_policy" "breaker" {
  name = "${local.project}-breaker"
  role = aws_iam_role.breaker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "StopTheApi"
        Effect   = "Allow"
        Action   = "lambda:PutFunctionConcurrency"
        Resource = aws_lambda_function.backend.arn
      },
      {
        Sid      = "OwnLogGroup"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.breaker.arn}:*"
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "breaker" {
  name              = "/aws/lambda/${local.project}-breaker"
  retention_in_days = 30
}

data "archive_file" "breaker" {
  type        = "zip"
  source_file = "${path.module}/functions/breaker/index.mjs"
  output_path = "${path.module}/.terraform/breaker.zip"
}

resource "aws_lambda_function" "breaker" {
  function_name = "${local.project}-breaker"
  role          = aws_iam_role.breaker.arn

  filename         = data.archive_file.breaker.output_path
  source_code_hash = data.archive_file.breaker.output_base64sha256

  handler       = "index.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]
  memory_size   = 128
  timeout       = 10

  # Its own small reservation: it can't be starved by the flood it stops (the
  # API's copies come out of the API's own reservation), and it can't run
  # away itself. The account's concurrency quota must cover this too
  # (lambda_reserved_concurrency + 1 + Lambda's 10 unreserved).
  reserved_concurrent_executions = 1

  logging_config {
    log_format            = "JSON"
    application_log_level = "INFO"
    system_log_level      = "WARN"
    log_group             = aws_cloudwatch_log_group.breaker.name
  }

  environment {
    variables = {
      API_FUNCTION_NAME = aws_lambda_function.backend.function_name
    }
  }

  depends_on = [aws_cloudwatch_log_group.breaker, aws_iam_role_policy.breaker]
}

resource "aws_lambda_permission" "breaker_sns" {
  statement_id  = "AllowBreakerTopic"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.breaker.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.breaker.arn
}

resource "aws_sns_topic_subscription" "breaker" {
  topic_arn = aws_sns_topic.breaker.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.breaker.arn

  depends_on = [aws_lambda_permission.breaker_sns]
}

# --- The trips (primary region, beside the function) ------------------------------

# ConcurrentExecutions per function is published because the API has reserved
# concurrency. A handful of hydrologists make one request at a time each, and
# the two queue mappings hold at most 4 copies for seconds, so 6 copies for
# 15 minutes is a flood.
resource "aws_cloudwatch_metric_alarm" "breaker_concurrency" {
  alarm_name          = "${local.project}-breaker-api-concurrency"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  metric_name         = "ConcurrentExecutions"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Maximum"
  threshold           = var.breaker_concurrency_threshold
  alarm_description   = "API Lambda held breaker_concurrency_threshold or more copies busy for 15 minutes. The breaker has set its reserved concurrency to 0: the API answers 429 until reset (docs/security.md § Incident playbook: find the cause, then terraform apply)."
  alarm_actions       = [aws_sns_topic.alerts.arn, aws_sns_topic.breaker.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.backend.function_name
  }
}

# A clock hour's billed milliseconds. 7 200 000 ms is 288 requests of 25 s
# (the longest CHIRPS read) in one hour; a hydrologist extending a network
# makes a handful.
resource "aws_cloudwatch_metric_alarm" "breaker_duration" {
  alarm_name          = "${local.project}-breaker-api-duration"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 3600
  statistic           = "Sum"
  threshold           = var.breaker_duration_ms_per_hour
  alarm_description   = "API Lambda ran more than breaker_duration_ms_per_hour milliseconds in an hour (default: 2 copies busy the whole hour). The breaker has set its reserved concurrency to 0: the API answers 429 until reset (docs/security.md § Incident playbook: find the cause, then terraform apply)."
  alarm_actions       = [aws_sns_topic.alerts.arn, aws_sns_topic.breaker.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.backend.function_name
  }
}

# The breaker itself failed (it throws on a refused PutFunctionConcurrency;
# SNS's async invoke retries twice): the API is still running and the
# manual kill switch is needed.
resource "aws_cloudwatch_metric_alarm" "breaker_errors" {
  alarm_name          = "${local.project}-breaker-errors"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  alarm_description   = "The spend breaker failed to stop the API Lambda: run the manual kill switch now (docs/security.md § Incident playbook), then read /aws/lambda/pitman-breaker."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.breaker.function_name
  }
}
