# Credential-free tests of the spend and alerting guardrails (the pre-launch
# infra review, 2026-11-07): the CloudFront traffic, Lambda invocation and
# Route 53 query alarms (5-minute sums), the budget (gross cost, its lines,
# the explicit opt-out for 0), the daily budget and Cost Anomaly Detection
# (R4-I13), alert_email refusing empty and example
# addresses, the user and usage tables' throughput ceilings, the spend
# circuit breaker (its single permission, its wiring, its thresholds' bounds),
# the Cape Farm Mapper token wired from a variable, the Lambda's JSON
# logging, and DATA_REGION following icwbt_region rather than aws_region.
#   terraform -chdir=infra init -backend=false && terraform -chdir=infra test
#
# Mocked providers, `command = plan`, no AWS account, no state.

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
  mock_data "aws_route53_zone" {
    defaults = {
      zone_id = "Z0PITMANEXAMPLE"
      arn     = "arn:aws:route53:::hostedzone/Z0PITMANEXAMPLE"
    }
  }
  mock_resource "aws_cloudwatch_log_group" {
    override_during = plan
    defaults = {
      arn = "arn:aws:logs:af-south-1:111111111111:log-group:/aws/lambda/pitman-backend"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
}

mock_provider "random" {}
mock_provider "archive" {}

# The two alert topics get distinct ARNs, so an alarm wired to the wrong
# region's topic fails.
override_resource {
  target          = aws_sns_topic.alerts
  override_during = plan
  values = {
    arn = "arn:aws:sns:af-south-1:111111111111:pitman-prod-alerts"
  }
}

override_resource {
  target          = aws_sns_topic.alerts_us_east_1
  override_during = plan
  values = {
    arn = "arn:aws:sns:us-east-1:111111111111:pitman-prod-alerts"
  }
}

override_resource {
  target          = aws_cloudfront_distribution.frontend
  override_during = plan
  # The ARN too: the Lambda permissions' source_arn must parse as one (#33).
  values = {
    id  = "EDFDVBD6EXAMPLE"
    arn = "arn:aws:cloudfront::111111111111:distribution/EDFDVBD6EXAMPLE"
  }
}

variables {
  alert_email = "alerts@pitman.jaredhoward.com"
}

# --- CloudFront traffic alarms ------------------------------------------------

run "cloudfront_traffic_alarms" {
  command = plan

  assert {
    condition = alltrue([
      for a in [aws_cloudwatch_metric_alarm.cloudfront_requests, aws_cloudwatch_metric_alarm.cloudfront_bytes] :
      a.namespace == "AWS/CloudFront" && a.statistic == "Sum" && a.period == 300 && a.evaluation_periods == 1 &&
      a.comparison_operator == "GreaterThanThreshold" && a.treat_missing_data == "notBreaching" &&
      a.dimensions["DistributionId"] == "EDFDVBD6EXAMPLE" && a.dimensions["Region"] == "Global" &&
      a.alarm_actions == toset(["arn:aws:sns:us-east-1:111111111111:pitman-prod-alerts"])
    ])
    error_message = "Both traffic alarms sum 5 minutes of this distribution's Global metric (one period is enough: two would let a flood alternate windows) and notify the us-east-1 topic."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.cloudfront_requests.metric_name == "Requests" && aws_cloudwatch_metric_alarm.cloudfront_requests.threshold == 1667
    error_message = "The requests alarm watches Requests, default 20 000 an hour, so 1 667 per 5 minutes."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.cloudfront_bytes.metric_name == "BytesDownloaded" && aws_cloudwatch_metric_alarm.cloudfront_bytes.threshold == 89478486
    error_message = "The bytes alarm watches BytesDownloaded, default 1 GB an hour, so a twelfth of 1 GiB per 5 minutes, in bytes."
  }
}

run "lambda_invocations_alarm_is_5_minutes" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.lambda_invocations.period == 300 &&
      aws_cloudwatch_metric_alarm.lambda_invocations.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.lambda_invocations.threshold == 167 &&
      aws_cloudwatch_metric_alarm.lambda_invocations.alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "Invocations: 2 000 an hour as 167 per 5 minutes, to the primary topic."
  }
}

run "route53_queries_alarm" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.route53_queries.namespace == "AWS/Route53" &&
      aws_cloudwatch_metric_alarm.route53_queries.metric_name == "DNSQueries" &&
      aws_cloudwatch_metric_alarm.route53_queries.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.route53_queries.period == 300 &&
      aws_cloudwatch_metric_alarm.route53_queries.threshold == 1667 &&
      aws_cloudwatch_metric_alarm.route53_queries.dimensions["HostedZoneId"] == "Z0PITMANEXAMPLE"
    )
    error_message = "DNSQueries on the site's zone, 20 000 an hour as 1 667 per 5 minutes."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.route53_queries.alarm_actions == toset(["arn:aws:sns:us-east-1:111111111111:pitman-prod-alerts"])
    error_message = "Route 53's metrics are in us-east-1, so the alarm notifies the us-east-1 topic."
  }
}

run "route53_threshold_below_one_per_window_refused" {
  command = plan
  variables {
    route53_queries_alarm_per_hour = 11
  }
  expect_failures = [var.route53_queries_alarm_per_hour]
}

run "cloudfront_alarm_thresholds_follow_variables" {
  command = plan

  variables {
    cloudfront_requests_alarm_per_hour = 1234
    cloudfront_gb_alarm_per_hour       = 2
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.cloudfront_requests.threshold == 103 && aws_cloudwatch_metric_alarm.cloudfront_bytes.threshold == 178956971
    error_message = "The thresholds are a twelfth of the per-hour variables, rounded up (GB converted to bytes)."
  }
}

run "cloudfront_requests_threshold_zero_refused" {
  command = plan
  variables {
    cloudfront_requests_alarm_per_hour = 0
  }
  expect_failures = [var.cloudfront_requests_alarm_per_hour]
}

run "cloudfront_gb_threshold_zero_refused" {
  command = plan
  variables {
    cloudfront_gb_alarm_per_hour = 0
  }
  expect_failures = [var.cloudfront_gb_alarm_per_hour]
}

# --- the budget -----------------------------------------------------------------

run "budget_is_gross_with_80_and_100_lines" {
  command = plan

  assert {
    condition     = length(aws_budgets_budget.monthly) == 1 && aws_budgets_budget.monthly[0].limit_amount == "25"
    error_message = "The default budget is $25."
  }
  assert {
    condition     = !aws_budgets_budget.monthly[0].cost_types[0].include_credit && !aws_budgets_budget.monthly[0].cost_types[0].include_refund
    error_message = "Credits and refunds must not net out of the budget (they would hide a runaway)."
  }
  assert {
    condition = sort([
      for n in aws_budgets_budget.monthly[0].notification : "${n.notification_type}-${n.threshold}"
    ]) == sort(["FORECASTED-100", "ACTUAL-80", "ACTUAL-100"])
    error_message = "Budget lines: forecasted 100 %, actual 80 % (above the fixed baseline) and actual 100 %."
  }
  assert {
    condition = alltrue([
      for n in aws_budgets_budget.monthly[0].notification :
      n.subscriber_email_addresses == toset(["alerts@pitman.jaredhoward.com"]) && n.subscriber_sns_topic_arns == toset(["arn:aws:sns:us-east-1:111111111111:pitman-prod-alerts"])
    ])
    error_message = "Every budget line emails alert_email directly and notifies the us-east-1 topic (not the opt-in region's)."
  }
  # Budgets may publish to the us-east-1 topic only, as AWS's guide gives the
  # statement; CloudWatch to both.
  assert {
    condition = jsonencode([
      for s in data.aws_iam_policy_document.alerts_publish["us_east_1"].statement : {
        sid        = s.sid
        principals = flatten([for p in s.principals : tolist(p.identifiers)])
        conditions = { for c in s.condition : "${c.test} ${c.variable}" => tolist(c.values) }
      }
      ]) == jsonencode([
      { sid = "AllowCloudWatch", principals = ["cloudwatch.amazonaws.com"], conditions = { "StringEquals aws:SourceAccount" = ["111111111111"] } },
      { sid = "AllowBudgets", principals = ["budgets.amazonaws.com"], conditions = { "ArnLike aws:SourceArn" = ["arn:aws:budgets::111111111111:*"], "StringEquals aws:SourceAccount" = ["111111111111"] } },
      { sid = "AllowCostAnomalyDetection", principals = ["costalerts.amazonaws.com"], conditions = { "StringEquals aws:SourceAccount" = ["111111111111"] } },
    ])
    error_message = "The us-east-1 topic admits CloudWatch, this account's budgets (SourceAccount and SourceArn) and this account's Cost Anomaly Detection."
  }
  assert {
    condition = jsonencode([
      for s in data.aws_iam_policy_document.alerts_publish["primary"].statement : flatten([for p in s.principals : tolist(p.identifiers)])
    ]) == jsonencode([["cloudwatch.amazonaws.com"]])
    error_message = "The af-south-1 topic admits CloudWatch only: the budgets and anomaly alerts publish to us-east-1."
  }
}

run "daily_budget_derived_gross_actual_100" {
  command = plan

  assert {
    condition     = length(aws_budgets_budget.daily) == 1 && aws_budgets_budget.daily[0].limit_amount == "2" && aws_budgets_budget.daily[0].time_unit == "DAILY"
    error_message = "The daily budget is derived: ceil(25 x 2.25 / 30) = $2 a day."
  }
  assert {
    condition     = !aws_budgets_budget.daily[0].cost_types[0].include_credit && !aws_budgets_budget.daily[0].cost_types[0].include_refund
    error_message = "The daily budget is gross too: credits and refunds would hide a runaway."
  }
  assert {
    condition = [
      for n in aws_budgets_budget.daily[0].notification : "${n.notification_type}-${n.threshold}"
    ] == ["ACTUAL-100"]
    error_message = "The daily budget has one line, actual 100 % (a daily budget has no forecast)."
  }
  assert {
    condition = alltrue([
      for n in aws_budgets_budget.daily[0].notification :
      n.subscriber_email_addresses == toset(["alerts@pitman.jaredhoward.com"]) && n.subscriber_sns_topic_arns == toset(["arn:aws:sns:us-east-1:111111111111:pitman-prod-alerts"])
    ])
    error_message = "The daily budget emails alert_email directly and notifies the us-east-1 topic."
  }
}

run "daily_budget_follows_monthly" {
  command = plan
  variables {
    budget_monthly_usd = 40
  }

  assert {
    condition     = aws_budgets_budget.daily[0].limit_amount == "3"
    error_message = "ceil(40 x 2.25 / 30) = ceil(3.0) = $3."
  }
}

run "daily_budget_explicit" {
  command = plan
  variables {
    budget_daily_usd = 5
  }

  assert {
    condition     = aws_budgets_budget.daily[0].limit_amount == "5"
    error_message = "An explicit budget_daily_usd is used as is."
  }
}

run "daily_budget_zero_skips_only_daily" {
  command = plan
  variables {
    budget_daily_usd = 0
  }

  assert {
    condition     = length(aws_budgets_budget.daily) == 0 && length(aws_budgets_budget.monthly) == 1
    error_message = "budget_daily_usd = 0 drops the daily budget and keeps the monthly one."
  }
}

run "daily_budget_not_below_monthly_refused" {
  command = plan
  variables {
    budget_daily_usd = 25
  }
  expect_failures = [var.budget_daily_usd]
}

run "daily_budget_negative_refused" {
  command = plan
  variables {
    budget_daily_usd = -1
  }
  expect_failures = [var.budget_daily_usd]
}

run "cost_anomaly_off_by_default" {
  command = plan

  assert {
    condition     = length(aws_ce_anomaly_monitor.services) == 0 && length(aws_ce_anomaly_subscription.services) == 0
    error_message = "Cost Anomaly Detection is off until the operator turns it on after the first apply (an account holds one SERVICE monitor)."
  }
}

run "cost_anomaly_on_publishes_to_us_east_1" {
  command = plan
  variables {
    cost_anomaly_threshold_usd = 5
  }

  assert {
    condition     = aws_ce_anomaly_monitor.services[0].monitor_type == "DIMENSIONAL" && aws_ce_anomaly_monitor.services[0].monitor_dimension == "SERVICE"
    error_message = "One dimensional monitor over AWS services."
  }
  assert {
    condition = (
      aws_ce_anomaly_subscription.services[0].frequency == "IMMEDIATE"
      && one(aws_ce_anomaly_subscription.services[0].subscriber).type == "SNS"
      && one(aws_ce_anomaly_subscription.services[0].subscriber).address == "arn:aws:sns:us-east-1:111111111111:pitman-prod-alerts"
    )
    error_message = "Anomalies go immediately to the us-east-1 topic (whose policy admits costalerts.amazonaws.com)."
  }
  assert {
    condition = (
      one(aws_ce_anomaly_subscription.services[0].threshold_expression[0].dimension).key == "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      && tolist(one(aws_ce_anomaly_subscription.services[0].threshold_expression[0].dimension).values) == tolist(["5"])
      && tolist(one(aws_ce_anomaly_subscription.services[0].threshold_expression[0].dimension).match_options) == tolist(["GREATER_THAN_OR_EQUAL"])
    )
    error_message = "The subscription fires on an anomaly whose total impact is at least cost_anomaly_threshold_usd."
  }
}

# --- the optional flat-rate plan (R4-I15) -------------------------------------------

run "flat_rate_plan_off_by_default" {
  command = plan

  assert {
    condition     = length(aws_pricingplanmanager_subscription.cloudfront) == 0
    error_message = "No flat-rate subscription unless cloudfront_flat_rate_plan asks for one: pay-as-you-go is the default."
  }
}

run "flat_rate_plan_pro_waits_for_manual_approval" {
  command = plan
  variables {
    cloudfront_flat_rate_plan = "PRO"
  }

  override_resource {
    target          = aws_wafv2_web_acl.frontend
    override_during = plan
    values = {
      arn = "arn:aws:wafv2:us-east-1:111111111111:global/webacl/pitman-frontend-acl/00000000-0000-0000-0000-000000000000"
    }
  }

  assert {
    condition = (
      aws_pricingplanmanager_subscription.cloudfront[0].plan_family == "CloudFront"
      && aws_pricingplanmanager_subscription.cloudfront[0].plan_tier == "PRO"
    )
    error_message = "The CloudFront plan family, Pro tier."
  }
  assert {
    condition     = aws_pricingplanmanager_subscription.cloudfront[0].approval_mode == "MANUAL"
    error_message = "approval_mode must be MANUAL: the subscription waits, unbilled, for the operator's approval in the console (IMMEDIATE would start billing on apply)."
  }
  assert {
    condition = aws_pricingplanmanager_subscription.cloudfront[0].resource_arns == toset([
      "arn:aws:cloudfront::111111111111:distribution/EDFDVBD6EXAMPLE",
      "arn:aws:wafv2:us-east-1:111111111111:global/webacl/pitman-frontend-acl/00000000-0000-0000-0000-000000000000",
      "arn:aws:route53:::hostedzone/Z0PITMANEXAMPLE",
    ])
    error_message = "The plan covers exactly the distribution, its web ACL and the site's zone."
  }
}

run "flat_rate_plan_business_refused" {
  command = plan
  variables {
    cloudfront_flat_rate_plan = "BUSINESS"
  }
  expect_failures = [var.cloudfront_flat_rate_plan]
}

run "flat_rate_plan_lowercase_refused" {
  command = plan
  variables {
    cloudfront_flat_rate_plan = "pro"
  }
  expect_failures = [var.cloudfront_flat_rate_plan]
}

run "cost_anomaly_negative_refused" {
  command = plan
  variables {
    cost_anomaly_threshold_usd = -1
  }
  expect_failures = [var.cost_anomaly_threshold_usd]
}

run "budget_zero_refused_without_opt_out" {
  command = plan
  variables {
    budget_monthly_usd = 0
  }
  expect_failures = [var.budget_monthly_usd]
}

run "budget_negative_refused" {
  command = plan
  variables {
    budget_monthly_usd     = -1
    no_budget_acknowledged = true
  }
  expect_failures = [var.budget_monthly_usd]
}

run "budget_zero_with_opt_out_creates_none" {
  command = plan
  variables {
    budget_monthly_usd     = 0
    no_budget_acknowledged = true
  }

  assert {
    condition     = length(aws_budgets_budget.monthly) == 0 && length(aws_budgets_budget.daily) == 0
    error_message = "budget_monthly_usd = 0 with the explicit opt-out creates no budget, monthly or daily (no billing access yet)."
  }
}

# --- alert_email ------------------------------------------------------------------

run "alert_email_subscribes_both_topics" {
  command = plan

  assert {
    condition     = aws_sns_topic_subscription.alerts_email.endpoint == "alerts@pitman.jaredhoward.com" && aws_sns_topic_subscription.alerts_us_east_1_email.endpoint == "alerts@pitman.jaredhoward.com"
    error_message = "alert_email subscribes to the topics in both regions."
  }
  assert {
    condition     = aws_sns_topic_subscription.alerts_email.topic_arn == "arn:aws:sns:af-south-1:111111111111:pitman-prod-alerts" && aws_sns_topic_subscription.alerts_us_east_1_email.topic_arn == "arn:aws:sns:us-east-1:111111111111:pitman-prod-alerts"
    error_message = "Each subscription is on its own region's topic."
  }
}

run "alert_email_empty_refused" {
  command = plan
  variables {
    alert_email = ""
  }
  expect_failures = [var.alert_email]
}

run "alert_email_example_com_refused" {
  command = plan
  variables {
    alert_email = "you+pitman-aws-alerts@example.com"
  }
  expect_failures = [var.alert_email]
}

run "alert_email_example_subdomain_refused" {
  command = plan
  variables {
    alert_email = "ops@mail.Example.ORG"
  }
  expect_failures = [var.alert_email]
}

run "alert_email_test_tld_refused" {
  command = plan
  variables {
    alert_email = "admin@pitman.test"
  }
  expect_failures = [var.alert_email]
}

run "alert_email_invalid_tld_refused" {
  command = plan
  variables {
    alert_email = "admin@nowhere.invalid"
  }
  expect_failures = [var.alert_email]
}

run "alert_email_not_an_address_refused" {
  command = plan
  variables {
    alert_email = "alerts"
  }
  expect_failures = [var.alert_email]
}

run "alert_email_lookalike_domain_accepted" {
  command = plan
  variables {
    alert_email = "ops@myexample.com"
  }
}

# --- the user table's ceiling --------------------------------------------------

run "users_table_throughput_capped" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.users.on_demand_throughput[0].max_read_request_units == 50 && aws_dynamodb_table.users.on_demand_throughput[0].max_write_request_units == 10
    error_message = "The on-demand user table is capped at 50 read and 10 write request units a second ($43.55 a month at most)."
  }
}

# --- the usage table (per-user quotas, R4-I9) -------------------------------------

run "usage_table_contract" {
  command = plan

  assert {
    condition = (
      aws_dynamodb_table.usage.name == "pitman-usage" &&
      aws_dynamodb_table.usage.billing_mode == "PAY_PER_REQUEST" &&
      aws_dynamodb_table.usage.hash_key == "pk" &&
      aws_dynamodb_table.usage.range_key == null &&
      one([for a in aws_dynamodb_table.usage.attribute : a.type if a.name == "pk"]) == "S" &&
      length(aws_dynamodb_table.usage.attribute) == 1
    )
    error_message = "The backend's contract: pitman-usage, on-demand, hash key pk (S), no sort key, no index."
  }
  assert {
    condition     = aws_dynamodb_table.usage.ttl[0].attribute_name == "expires_at" && aws_dynamodb_table.usage.ttl[0].enabled
    error_message = "TTL on expires_at (epoch seconds)."
  }
  assert {
    condition     = aws_dynamodb_table.usage.on_demand_throughput[0].max_read_request_units == 5 && aws_dynamodb_table.usage.on_demand_throughput[0].max_write_request_units == 10
    error_message = "The usage table is capped at 5 read and 10 write units a second ($23.95 a month at most)."
  }
  assert {
    condition     = !aws_dynamodb_table.usage.point_in_time_recovery[0].enabled
    error_message = "No PITR on throwaway counters."
  }
  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["USAGE_STORE"] == "dynamodb" && aws_lambda_function.backend.environment[0].variables["USAGE_TABLE"] == "pitman-usage"
    error_message = "The Lambda finds the table through USAGE_STORE and USAGE_TABLE."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.usage_table_throttles.metric_name == "ThrottledRequests" &&
      aws_cloudwatch_metric_alarm.usage_table_throttles.dimensions["TableName"] == "pitman-usage" &&
      aws_cloudwatch_metric_alarm.usage_table_throttles.dimensions["Operation"] == "UpdateItem" &&
      aws_cloudwatch_metric_alarm.usage_table_throttles.threshold == 0 &&
      aws_cloudwatch_metric_alarm.usage_table_throttles.alarm_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "Any throttle on the usage table's UpdateItem mails the primary topic."
  }
}

# --- the spend circuit breaker (breaker.tf, R4-I7) ----------------------------------

run "breaker_wiring" {
  command = plan

  override_resource {
    target          = aws_lambda_function.backend
    override_during = plan
    values = {
      arn = "arn:aws:lambda:af-south-1:111111111111:function:pitman-backend"
    }
  }
  override_resource {
    target          = aws_lambda_function.breaker
    override_during = plan
    values = {
      arn = "arn:aws:lambda:af-south-1:111111111111:function:pitman-breaker"
    }
  }
  override_resource {
    target          = aws_sns_topic.breaker
    override_during = plan
    values = {
      arn = "arn:aws:sns:af-south-1:111111111111:pitman-breaker"
    }
  }
  override_resource {
    target          = aws_iam_role.breaker
    override_during = plan
    values = {
      id  = "pitman-breaker"
      arn = "arn:aws:iam::111111111111:role/pitman-breaker"
    }
  }
  override_resource {
    target          = aws_cloudwatch_log_group.breaker
    override_during = plan
    values = {
      arn = "arn:aws:logs:af-south-1:111111111111:log-group:/aws/lambda/pitman-breaker"
    }
  }

  # The role holds one action on the API, and its own logs.
  assert {
    condition = jsondecode(aws_iam_role_policy.breaker.policy).Statement == [
      {
        Sid      = "StopTheApi"
        Effect   = "Allow"
        Action   = "lambda:PutFunctionConcurrency"
        Resource = "arn:aws:lambda:af-south-1:111111111111:function:pitman-backend"
      },
      {
        Sid      = "OwnLogGroup"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:af-south-1:111111111111:log-group:/aws/lambda/pitman-breaker:*"
      },
    ]
    error_message = "The breaker's role may only PutFunctionConcurrency on the API function, plus write its own log group."
  }
  assert {
    condition     = aws_iam_role_policy.breaker.role == aws_iam_role.breaker.id && aws_lambda_function.breaker.role == aws_iam_role.breaker.arn
    error_message = "The breaker runs under its own role, never the API's."
  }
  assert {
    condition = (
      aws_lambda_function.breaker.runtime == "nodejs24.x" &&
      aws_lambda_function.breaker.architectures == tolist(["arm64"]) &&
      aws_lambda_function.breaker.reserved_concurrent_executions >= 1 &&
      aws_lambda_function.breaker.reserved_concurrent_executions <= 2 &&
      aws_lambda_function.breaker.timeout <= 15 &&
      aws_lambda_function.breaker.environment[0].variables["API_FUNCTION_NAME"] == "pitman-backend" &&
      aws_cloudwatch_log_group.breaker.retention_in_days == 30
    )
    error_message = "Node 24 on arm64, 1-2 reserved copies, a short timeout, the API's name, 30-day logs."
  }
  # SNS -> Lambda, only from the breaker topic.
  assert {
    condition = (
      aws_sns_topic_subscription.breaker.topic_arn == "arn:aws:sns:af-south-1:111111111111:pitman-breaker" &&
      aws_sns_topic_subscription.breaker.protocol == "lambda" &&
      aws_sns_topic_subscription.breaker.endpoint == "arn:aws:lambda:af-south-1:111111111111:function:pitman-breaker" &&
      aws_lambda_permission.breaker_sns.principal == "sns.amazonaws.com" &&
      aws_lambda_permission.breaker_sns.source_arn == "arn:aws:sns:af-south-1:111111111111:pitman-breaker" &&
      aws_lambda_permission.breaker_sns.function_name == "pitman-breaker"
    )
    error_message = "The breaker function subscribes to the breaker topic and only that topic may invoke it."
  }
  # Every trip mails the operator and fires the breaker; none is wired to the us-east-1 topic.
  assert {
    condition = alltrue([
      for a in [aws_cloudwatch_metric_alarm.breaker_concurrency, aws_cloudwatch_metric_alarm.breaker_duration, aws_cloudwatch_metric_alarm.breaker_invocations] :
      a.alarm_actions == toset(["arn:aws:sns:af-south-1:111111111111:pitman-prod-alerts", "arn:aws:sns:af-south-1:111111111111:pitman-breaker"]) &&
      a.namespace == "AWS/Lambda" && a.dimensions["FunctionName"] == "pitman-backend" && a.treat_missing_data == "notBreaching"
    ])
    error_message = "Each trip notifies the alert topic and the breaker topic, on the API function's metrics."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.breaker_concurrency.metric_name == "ConcurrentExecutions" &&
      aws_cloudwatch_metric_alarm.breaker_concurrency.statistic == "Maximum" &&
      aws_cloudwatch_metric_alarm.breaker_concurrency.period == 300 &&
      aws_cloudwatch_metric_alarm.breaker_concurrency.evaluation_periods == 3 &&
      aws_cloudwatch_metric_alarm.breaker_concurrency.datapoints_to_alarm == 3 &&
      aws_cloudwatch_metric_alarm.breaker_concurrency.comparison_operator == "GreaterThanOrEqualToThreshold" &&
      aws_cloudwatch_metric_alarm.breaker_concurrency.threshold == 6
    )
    error_message = "Concurrency trip: Maximum >= 6 in 3 of 3 five-minute periods."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.breaker_duration.metric_name == "Duration" &&
      aws_cloudwatch_metric_alarm.breaker_duration.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.breaker_duration.period == 3600 &&
      aws_cloudwatch_metric_alarm.breaker_duration.evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.breaker_duration.threshold == 7200000
    )
    error_message = "Duration trip: an hour's Sum above 7 200 000 ms (2 copies busy the whole hour)."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.breaker_invocations.alarm_name == "pitman-breaker-api-invocations" &&
      aws_cloudwatch_metric_alarm.breaker_invocations.metric_name == "Invocations" &&
      aws_cloudwatch_metric_alarm.breaker_invocations.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.breaker_invocations.period == 300 &&
      aws_cloudwatch_metric_alarm.breaker_invocations.evaluation_periods == 3 &&
      aws_cloudwatch_metric_alarm.breaker_invocations.datapoints_to_alarm == 3 &&
      aws_cloudwatch_metric_alarm.breaker_invocations.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.breaker_invocations.threshold == 3000
    )
    error_message = "Invocations trip: Sum above 3 000 in 3 of 3 five-minute periods (10 a second for 15 minutes)."
  }
  # Every trip is named pitman-breaker-api-*, the prefix the topic policy and
  # the reset script (infra/scripts/breaker-reset.sh) rely on; breaker_errors isn't.
  assert {
    condition = alltrue([
      for a in [aws_cloudwatch_metric_alarm.breaker_concurrency, aws_cloudwatch_metric_alarm.breaker_duration, aws_cloudwatch_metric_alarm.breaker_invocations] :
      startswith(a.alarm_name, "pitman-breaker-api-")
    ]) && !startswith(aws_cloudwatch_metric_alarm.breaker_errors.alarm_name, "pitman-breaker-api-")
    error_message = "The three trips share the pitman-breaker-api- prefix; the errors alarm must not."
  }
  # Only those alarms, in this account and region, may publish to the breaker topic.
  assert {
    condition = jsonencode([
      for s in data.aws_iam_policy_document.breaker_publish.statement : {
        principals = flatten([for p in s.principals : tolist(p.identifiers)])
        actions    = tolist(s.actions)
        conditions = { for c in s.condition : "${c.test} ${c.variable}" => tolist(c.values) }
      }
      ]) == jsonencode([{
        principals = ["cloudwatch.amazonaws.com"]
        actions    = ["sns:Publish"]
        conditions = {
          "ArnLike aws:SourceArn"          = ["arn:aws:cloudwatch:af-south-1:111111111111:alarm:pitman-breaker-api-*"]
          "StringEquals aws:SourceAccount" = ["111111111111"]
        }
    }])
    error_message = "Only CloudWatch, for this account's pitman-breaker-api-* alarms, may publish to the breaker topic."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.breaker_errors.dimensions["FunctionName"] == "pitman-breaker" &&
      aws_cloudwatch_metric_alarm.breaker_errors.metric_name == "Errors" &&
      aws_cloudwatch_metric_alarm.breaker_errors.alarm_actions == toset(["arn:aws:sns:af-south-1:111111111111:pitman-prod-alerts"])
    )
    error_message = "A failed trip mails the operator (and never loops back into the breaker)."
  }
  # The breaker's 0 is drift: the API function owns its reserved concurrency, so apply resets it.
  assert {
    condition     = aws_lambda_function.backend.reserved_concurrent_executions == 10
    error_message = "The API function sets reserved_concurrent_executions from the variable, so an apply restores it after a trip."
  }
}

run "breaker_invocations_threshold_bounds" {
  command = plan
  variables {
    breaker_invocations_per_5_minutes = 6001
  }
  expect_failures = [var.breaker_invocations_per_5_minutes]
}

run "breaker_invocations_threshold_too_low_refused" {
  command = plan
  variables {
    breaker_invocations_per_5_minutes = 599
  }
  expect_failures = [var.breaker_invocations_per_5_minutes]
}

run "breaker_concurrency_threshold_above_reserved_refused" {
  command = plan
  variables {
    lambda_reserved_concurrency   = 5
    breaker_concurrency_threshold = 6
  }
  expect_failures = [var.breaker_concurrency_threshold]
}

run "breaker_concurrency_threshold_below_mappings_refused" {
  command = plan
  variables {
    breaker_concurrency_threshold = 3
  }
  expect_failures = [var.breaker_concurrency_threshold]
}

run "breaker_duration_above_2_gb_hours_refused" {
  command = plan
  variables {
    breaker_duration_ms_per_hour = 7200001
  }
  expect_failures = [var.breaker_duration_ms_per_hour]
}

run "breaker_duration_scales_with_memory" {
  command = plan
  variables {
    lambda_memory_mb              = 2048
    lambda_reserved_concurrency   = 5
    breaker_concurrency_threshold = 5
  }
  # 7 200 000 ms at 2 GB is 4 GB-hours an hour, about $183 a month: refused.
  expect_failures = [var.breaker_duration_ms_per_hour]
}

run "breaker_duration_below_one_copy_hour_refused" {
  command = plan
  variables {
    breaker_duration_ms_per_hour = 3599999
  }
  expect_failures = [var.breaker_duration_ms_per_hour]
}

# --- Cape Farm Mapper's token survives an apply (R7-C9) -----------------------------

run "cfm_off_by_default" {
  command = plan

  assert {
    condition     = nonsensitive(aws_lambda_function.backend.environment[0].variables["CFM_SOURCE"]) == "" && nonsensitive(aws_lambda_function.backend.environment[0].variables["CFM_TOKEN"]) == ""
    error_message = "No token: CFM_SOURCE and CFM_TOKEN empty, /cfm/* answers 503."
  }
}

run "cfm_token_wired_from_the_variable" {
  command = plan
  variables {
    cfm_token           = "test-token-not-real"
    cfm_crops_layer_url = "https://cfm.example.invalid/arcgis/rest/services/crops/FeatureServer/0"
  }

  assert {
    condition = (
      nonsensitive(aws_lambda_function.backend.environment[0].variables["CFM_SOURCE"]) == "cfm" &&
      nonsensitive(aws_lambda_function.backend.environment[0].variables["CFM_TOKEN"]) == "test-token-not-real" &&
      aws_lambda_function.backend.environment[0].variables["CFM_CROPS_LAYER_URL"] == "https://cfm.example.invalid/arcgis/rest/services/crops/FeatureServer/0" &&
      aws_lambda_function.backend.environment[0].variables["CFM_DAMS_LAYER_URL"] == ""
    )
    error_message = "With a token, Terraform sets CFM_SOURCE=cfm, the token and the layer URLs, so an apply never wipes them."
  }
}

run "cfm_token_without_crops_layer_refused" {
  command = plan
  variables {
    cfm_token = "test-token-not-real"
  }
  expect_failures = [var.cfm_token]
}

run "cfm_layer_over_http_refused" {
  command = plan
  variables {
    cfm_crops_layer_url = "http://cfm.example.invalid/arcgis/rest/services/crops/FeatureServer/0"
  }
  expect_failures = [var.cfm_crops_layer_url]
}

# --- Lambda logging --------------------------------------------------------------

run "lambda_logs_json_platform_warn_app_info" {
  command = plan

  assert {
    condition     = aws_lambda_function.backend.logging_config[0].log_format == "JSON" && aws_lambda_function.backend.logging_config[0].system_log_level == "WARN"
    error_message = "JSON logs with system logs at WARN (drops START/END/REPORT)."
  }
  assert {
    condition     = aws_lambda_function.backend.logging_config[0].application_log_level == "INFO"
    error_message = "Application logs stay at INFO: the backend's console.log lines feed the log-line alarms."
  }
  assert {
    condition     = aws_lambda_function.backend.logging_config[0].log_group == "/aws/lambda/pitman-backend"
    error_message = "Logs go to the log group Terraform owns (retention, metric filters)."
  }
}

# --- DATA_REGION ------------------------------------------------------------------

run "data_region_defaults_to_af_south_1" {
  command = plan

  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["DATA_REGION"] == "af-south-1"
    error_message = "DATA_REGION defaults to IC-WBT's region, af-south-1."
  }
}

run "data_region_independent_of_pitman_region" {
  command = plan
  variables {
    aws_region                = "eu-west-1"
    data_outside_south_africa = true
  }

  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["DATA_REGION"] == "af-south-1"
    error_message = "Moving Pitman's region must not move DATA_REGION: IC-WBT's buckets stay in icwbt_region."
  }
}

run "data_region_follows_icwbt_region" {
  command = plan
  variables {
    icwbt_region = "eu-west-1"
  }

  assert {
    condition     = aws_lambda_function.backend.environment[0].variables["DATA_REGION"] == "eu-west-1"
    error_message = "DATA_REGION is icwbt_region."
  }
}

run "icwbt_region_not_a_region_refused" {
  command = plan
  variables {
    icwbt_region = "cape town"
  }
  expect_failures = [var.icwbt_region]
}
